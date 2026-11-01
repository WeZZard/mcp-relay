import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { RelayManager, type AcquireInput, type ManagerOptions } from '../src/manager.js';
import { Registry } from '../src/registry.js';
import { MachineService, MachineServiceError, capacityRefusal } from '../src/machine-service.js';
import { durableCapture } from '../src/capture-gate.js';
import { consulAddress, discoveryMode, findDurableOwner, parseRegistrations } from '../src/discovery.js';
import { assemble, browse as mdnsBrowse, encodeQuery, parseRecords, type Advertised } from '../src/mdns.js';
import { validateRelayInput } from '../src/schema.js';

/**
 * Durable machines (docs/durable-machines.md): the cua-driver snapshot gate,
 * finding the instance that owns a machine, and a whole lease against a fake
 * durable machine-service that, like a real one seen from another Mac,
 * requires `lease_id` on every operation and refuses path-based transfers.
 */

const MACHINE = 'Mac-test-1';
const daemon = (fields: Record<string, unknown> = {}) => JSON.stringify({ accessibility: true, screen_recording: true, screen_recording_capturable: null, source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver', pid: 1021 }, ...fields });
const installed = { cua_driver: '0.19.3', node: '22.0.0' };

test('capture gate: granted only when the cua-driver daemon answers with Screen Recording', () => {
  const decision = durableCapture(MACHINE, installed, { code: 0, stdout: daemon() });
  assert.deepEqual([decision.capture, decision.state], [true, 'granted']);
  assert.match(decision.reason, /daemon on Mac-test-1 holds Screen Recording/);
});

test('capture gate: denied when the daemon lacks Screen Recording', () => {
  const decision = durableCapture(MACHINE, installed, { code: 0, stdout: daemon({ screen_recording: false }) });
  assert.deepEqual([decision.capture, decision.state], [false, 'denied']);
  assert.match(decision.reason, /lacks Screen Recording.*Grant it to CuaDriver/);
});

test('capture gate: unknown when the status command fails, cannot run, or answers something else', () => {
  for (const answer of [{ code: 1, stdout: '', stderr: 'boom' }, { error: 'connection lost' }, { code: 0, stdout: 'not json' }, { code: 0, stdout: JSON.stringify({ screen_recording: 'yes' }) }, undefined]) {
    const decision = durableCapture(MACHINE, installed, answer);
    assert.deepEqual([decision.capture, decision.state], [false, 'unknown'], JSON.stringify(answer));
  }
});

test('capture gate: daemon not running when the answer is not attributed to the daemon', () => {
  for (const source of [{ attribution: 'responsible-process', bundle_id: 'com.wezzard.machine-service' }, undefined]) {
    const decision = durableCapture(MACHINE, installed, { code: 0, stdout: daemon({ source }) });
    assert.deepEqual([decision.capture, decision.state], [false, 'daemon-not-running']);
    assert.match(decision.reason, /`cua-driver serve` daemon is not running/);
  }
  // machine-service's own grant never counts: only the daemon's answer decides (DC-32).
  assert.equal(durableCapture(MACHINE, installed, { code: 0, stdout: daemon({ screen_recording: true, source: { attribution: 'machine-service' } }) }).capture, false);
});

test('capture gate: absent when the capabilities list no cua-driver', () => {
  for (const software of [{ cua_driver: null }, null, undefined, {}]) {
    const decision = durableCapture(MACHINE, software, { code: 0, stdout: daemon() });
    assert.deepEqual([decision.capture, decision.state], [false, 'absent']);
  }
});

test('a leased or unavailable durable machine is a capacity refusal; other 409s are not (DC-34)', () => {
  const refusal = (error: string) => new MachineServiceError('x', 409, JSON.stringify({ error }));
  assert.equal(capacityRefusal(refusal('durable machine leased: Build-Mac-1 (purpose x, until y)')), true);
  assert.equal(capacityRefusal(refusal('durable machine unavailable: Build-Mac-1 (no logged-in GUI session)')), true);
  assert.equal(capacityRefusal(refusal('lease abc is not the current lease of durable machine Build-Mac-1')), false);
});

test('a non-loopback origin is accepted only when discovery found it', () => {
  assert.throws(() => new MachineService('http://192.0.2.4:6240'), /loopback HTTP\(S\) origin, or one discovery found/);
  assert.equal(new MachineService({ baseUrl: 'http://192.0.2.4:6240', listed: true }).baseUrl, 'http://192.0.2.4:6240');
  assert.throws(() => new MachineService({ baseUrl: 'http://user:pw@192.0.2.4:6240', listed: true }), /without credentials/);
});

/** A one-route stand-in for `GET /machines/<name>/files`: `bytes` zero bytes in 1 MiB chunks, with `digest` as the stated SHA-256, pausing `stallMs` after the first chunk. */
async function filesServer(t: TestContext, bytes: number, digest: (actual: string) => string, stallMs = 0) {
  const zero = Buffer.alloc(1 << 20), hash = createHash('sha256');
  for (let left = bytes; left > 0; left -= zero.length) hash.update(zero.subarray(0, Math.min(zero.length, left)));
  const actual = hash.digest('hex');
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'x-content-sha256': digest(actual) });
    for (let left = bytes, first = true; left > 0; left -= zero.length, first = false) {
      if (!res.write(zero.subarray(0, Math.min(zero.length, left)))) await new Promise(done => res.once('drain', done));
      if (first && stallMs) await new Promise(done => setTimeout(done, stallMs));
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-pull-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { service: new MachineService({ baseUrl: `http://127.0.0.1:${addr.port}`, timeoutMs: 15000 }), actual, to: join(root, 'pulled.bin') };
}

test('a byte pull larger than a string can hold streams to disk and checks its digest (DC-31)', { timeout: 120000 }, async t => {
  // Past V8's longest string (0x1fffffe8 characters), which a pull that decoded its body could not hold.
  const size = 0x1fffffe8 + (8 << 20);
  const f = await filesServer(t, size, actual => actual);
  const before = process.memoryUsage().rss;
  const pulled = await f.service.pullBytes(MACHINE, { lease_id: 'lease', remote_path: '/big.bin', to: f.to });
  assert.deepEqual(pulled, { sha256: f.actual, bytes: size });
  assert.equal((await import('node:fs')).statSync(f.to).size, size);
  assert.ok(process.memoryUsage().rss - before < 256 << 20, 'the pull never held the file in memory');
});

test('a byte pull whose bytes differ from the stated digest leaves no file', async t => {
  const f = await filesServer(t, 3 << 20, () => '0'.repeat(64));
  await assert.rejects(f.service.pullBytes(MACHINE, { remote_path: '/x.bin', to: f.to }), /differs from the stated/);
  await assert.rejects(readFile(f.to), /ENOENT/);
});

test('a byte pull is abandoned only when no byte arrives for its timeout', async t => {
  const f = await filesServer(t, 3 << 20, actual => actual, 600);
  await assert.rejects(f.service.pullBytes(MACHINE, { remote_path: '/x.bin', to: f.to }, { timeoutMs: 300 }), /timed out after 300ms without a byte/);
  await assert.rejects(readFile(f.to), /ENOENT/);
  const g = await filesServer(t, 3 << 20, actual => actual, 200);
  assert.equal((await g.service.pullBytes(MACHINE, { remote_path: '/x.bin', to: g.to }, { timeoutMs: 400 })).bytes, 3 << 20, 'a pull that keeps moving finishes however long it takes');
});

test('relay_acquire takes exactly one of image and machine', () => {
  const base = { action: 'acquire', guest: undefined, task: 'durable', extractions: [] };
  delete (base as { guest?: unknown }).guest;
  validateRelayInput({ ...base, machine: 'Build-Mac-1' });
  validateRelayInput({ ...base, image: 'macos26' });
  assert.throws(() => validateRelayInput({ ...base }), /exactly one of image/);
  assert.throws(() => validateRelayInput({ ...base, image: 'macos26', machine: 'Build-Mac-1' }), /exactly one of image/);
});

test('Consul registrations: service address, node fallback, instance and loopback_only', () => {
  const rows = parseRegistrations([
    { Node: { Node: 'n4', Address: '192.0.2.4' }, Service: { Address: '192.0.2.4', Port: 6240, Meta: { instance: 'Build-Mac-1', loopback_only: 'false' } } },
    { Node: { Node: 'n5', Address: '192.0.2.5' }, Service: { Address: '', Port: 6240, Meta: { loopback_only: 'true' } } },
    { Node: { Node: 'broken' }, Service: { Port: 6240 } },
  ]);
  assert.deepEqual(rows, [
    { node: 'n4', origin: 'http://192.0.2.4:6240', instance: 'Build-Mac-1', loopbackOnly: false },
    { node: 'n5', origin: 'http://192.0.2.5:6240', loopbackOnly: true },
  ]);
  assert.equal(consulAddress('127.0.0.1:18500'), 'http://127.0.0.1:18500');
  assert.equal(consulAddress(''), 'http://127.0.0.1:8500');
});

test('the owner of a durable machine is the one instance that lists it; others are skipped or refused', async () => {
  const list = (machines: Record<string, unknown>) => ({ machines, limits: { max_macos_running: 2, grace_hours: 6 }, pilot_repo: '', port: 6240 });
  const backend = (origin: string, machines: Record<string, unknown> | 'down', instance = MACHINE) => ({ baseUrl: origin, health: async () => ({ ok: true, service: 'machine-service', instance }), list: async () => { if (machines === 'down') throw new Error('unreachable'); return list(machines); } }) as any;
  const durable = { kind: 'durable', name: MACHINE, instance: MACHINE, state: 'available' };
  const local = backend('http://localhost:6240', { vm1: { kind: 'virtual', vm: 'vm1' } });
  const consul = [
    { Node: { Node: 'a' }, Service: { Address: '192.0.2.4', Port: 6240, Meta: { instance: MACHINE } } },
    { Node: { Node: 'b' }, Service: { Address: '192.0.2.5', Port: 6240, Meta: {} } },
    { Node: { Node: 'c' }, Service: { Address: '192.0.2.6', Port: 6240, Meta: { loopback_only: 'true' } } },
  ];
  const remotes: Record<string, any> = { 'http://192.0.2.4:6240': backend('http://192.0.2.4:6240', { [MACHINE]: durable }), 'http://192.0.2.5:6240': backend('http://192.0.2.5:6240', 'down') };
  const asked: string[] = [];
  const owner = await findDurableOwner(MACHINE, { local, mode: 'consul', fetchJson: async () => consul, backend: origin => { asked.push(origin); return remotes[origin]; } });
  assert.deepEqual([owner.origin, owner.instance], ['http://192.0.2.4:6240', MACHINE]);
  assert.deepEqual(asked.sort(), ['http://192.0.2.4:6240', 'http://192.0.2.5:6240'], 'a loopback_only registration on another Mac is never asked');
  await assert.rejects(findDurableOwner('Mac-other', { local, mode: 'consul', fetchJson: async () => consul, backend: origin => remotes[origin] }), /No machine-service instance lists a durable machine named Mac-other/);
  // Two instances that both list a machine of that name are ambiguous; one instance reached twice is not.
  remotes['http://192.0.2.5:6240'] = backend('http://192.0.2.5:6240', { [MACHINE]: { ...durable, instance: 'Other-Mac' } }, 'Other-Mac');
  await assert.rejects(findDurableOwner(MACHINE, { local, mode: 'consul', fetchJson: async () => consul, backend: origin => remotes[origin] }), /listed by more than one instance/);
  // Without Consul, the loopback instance alone may own it.
  const localOwner = await findDurableOwner(MACHINE, { local: backend('http://localhost:6240', { [MACHINE]: durable }), mode: 'consul', fetchJson: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(localOwner.origin, 'http://localhost:6240');
  await assert.rejects(findDurableOwner(MACHINE, { local, mode: 'consul', fetchJson: async () => { throw new Error('ECONNREFUSED'); } }), /Consul agent at http:\/\/127\.0\.0\.1:8500 did not answer/);
});

test('Bonjour mode: the owner is found by its advertisement, confirmed by /health, and counted once with the loopback instance (DC-35)', async () => {
  const list = (machines: Record<string, unknown>) => ({ machines, limits: { max_macos_running: 2, grace_hours: 6 }, pilot_repo: '', port: 6240 });
  const backend = (origin: string, machines: Record<string, unknown>, instance: string) => ({ baseUrl: origin, health: async () => ({ ok: true, service: 'machine-service', instance }), list: async () => list(machines) }) as any;
  const durable = (instance: string) => ({ kind: 'durable', name: instance, instance, state: 'available' });
  const advertised = (instance: string, address: string): Advertised => ({ name: instance, instance, host: `${instance}.local`, address, port: 6240, txt: { txtvers: '1', instance, kinds: 'durable' } });
  const remotes: Record<string, any> = { 'http://192.0.2.4:6240': backend('http://192.0.2.4:6240', { [MACHINE]: durable(MACHINE) }, MACHINE) };
  const local = backend('http://localhost:6240', {}, 'This-Mac');
  let consulAsked = false;
  const owner = await findDurableOwner(MACHINE, { local, mode: 'bonjour', browse: async () => [advertised(MACHINE, '192.0.2.4')], backend: origin => remotes[origin], fetchJson: async () => { consulAsked = true; return []; } });
  assert.deepEqual([owner.origin, owner.instance], ['http://192.0.2.4:6240', MACHINE]);
  assert.equal(consulAsked, false, 'Bonjour mode never asks Consul');
  // This Mac's own instance, asked on loopback and found again by its advertisement, is one owner.
  const self = backend('http://localhost:6240', { [MACHINE]: durable(MACHINE) }, MACHINE);
  remotes['http://192.0.2.9:6240'] = backend('http://192.0.2.9:6240', { [MACHINE]: durable(MACHINE) }, MACHINE);
  const mine = await findDurableOwner(MACHINE, { local: self, mode: 'bonjour', browse: async () => [advertised(MACHINE, '192.0.2.9')], backend: origin => remotes[origin] });
  assert.equal(mine.origin, 'http://localhost:6240');
  // An advertisement whose /health answers another ID is never used, and the refusal says so.
  remotes['http://192.0.2.4:6240'] = backend('http://192.0.2.4:6240', { [MACHINE]: durable(MACHINE) }, 'Someone-Else');
  await assert.rejects(findDurableOwner(MACHINE, { local, mode: 'bonjour', browse: async () => [advertised(MACHINE, '192.0.2.4')], backend: origin => remotes[origin] }), new RegExp(`unconfirmed: http://192\\.0\\.2\\.4:6240: it was found as ${MACHINE}, but its /health answers Someone-Else`));
  await assert.rejects(findDurableOwner(MACHINE, { local, mode: 'bonjour', browse: async () => { throw new Error('EHOSTUNREACH'); } }), /the Bonjour browse failed \(EHOSTUNREACH\)/);
  assert.equal(discoveryMode(undefined), 'bonjour');
  assert.equal(discoveryMode('consul'), 'consul');
  assert.throws(() => discoveryMode('mdns'), /MACHINE_SERVICE_DISCOVERY must be one of bonjour, consul/);
});

/** A DNS response: the given records in the answer section, names written out, with one compression pointer for the PTR target. */
function response(records: Array<{ name: string; type: number; data: Buffer }>): Buffer {
  const name = (n: string) => Buffer.concat([...n.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]), Buffer.from([0])]);
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(records.length, 6);
  const body = records.map(r => { const fixed = Buffer.alloc(10); fixed.writeUInt16BE(r.type, 0); fixed.writeUInt16BE(1, 2); fixed.writeUInt32BE(120, 4); fixed.writeUInt16BE(r.data.length, 8); return Buffer.concat([name(r.name), fixed, r.data]); });
  return Buffer.concat([header, ...body]);
}
const dnsName = (n: string) => Buffer.concat([...n.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]), Buffer.from([0])]);

test('the one-shot Multicast DNS query asks for the service and assembles PTR, SRV, TXT and A answers', async () => {
  const service = '_machine-service._tcp.local';
  const query = encodeQuery([{ name: service, type: 12 }]);
  assert.equal(query.readUInt16BE(4), 1, 'one question');
  assert.ok(query.includes(Buffer.from('_machine-service')), 'the question names the service');
  const srv = Buffer.alloc(6); srv.writeUInt16BE(6240, 4);
  const txt = Buffer.concat(['txtvers=1', 'instance=Build-Mac-1', 'kinds=durable'].map(pair => Buffer.concat([Buffer.from([pair.length]), Buffer.from(pair)])));
  const answer = response([
    { name: service, type: 12, data: dnsName(`Build-Mac-1.${service}`) },
    { name: `Build-Mac-1.${service}`, type: 33, data: Buffer.concat([srv, dnsName('Build-Mac-1.local')]) },
    { name: `Build-Mac-1.${service}`, type: 16, data: txt },
    { name: 'Build-Mac-1.local', type: 1, data: Buffer.from([192, 0, 2, 4]) },
  ]);
  const expected = [{ name: 'Build-Mac-1', instance: 'Build-Mac-1', host: 'Build-Mac-1.local', address: '192.0.2.4', port: 6240, txt: { txtvers: '1', instance: 'Build-Mac-1', kinds: 'durable' } }];
  assert.deepEqual(assemble(service, parseRecords(answer)), expected);
  // Responders compress names: here the SRV and TXT owners point at the PTR answer's target.
  const ptrData = 12 + dnsName(service).length + 10;
  const pointer = Buffer.from([0xc0 | (ptrData >> 8), ptrData & 0xff]);
  const record = (type: number, data: Buffer) => { const fixed = Buffer.alloc(10); fixed.writeUInt16BE(type, 0); fixed.writeUInt16BE(1, 2); fixed.writeUInt32BE(120, 4); fixed.writeUInt16BE(data.length, 8); return Buffer.concat([pointer, fixed, data]); };
  const ptrEnd = ptrData + dnsName(`Build-Mac-1.${service}`).length;
  const compressed = Buffer.concat([answer.subarray(0, ptrEnd), record(33, Buffer.concat([srv, dnsName('Build-Mac-1.local')])), record(16, txt), answer.subarray(answer.length - (dnsName('Build-Mac-1.local').length + 10 + 4))]);
  assert.deepEqual(assemble(service, parseRecords(compressed)), expected);
  // A message cut short keeps the records that parsed before the cut.
  assert.equal(parseRecords(answer.subarray(0, answer.length - 3)).length, 3);
  // browse() sends the query and reads the answers for its window, through any transport.
  const sent: Buffer[] = [];
  const found = await mdnsBrowse(service, 50, 50, async receive => ({ send: q => { sent.push(q); if (sent.length === 1) receive(answer); }, close: () => {} }));
  assert.deepEqual(found, expected);
  assert.equal(sent.length, 1, 'no follow-up when the first answers were complete');
  assert.deepEqual(parseRecords(Buffer.from('not dns')), []);
});

const bundle = fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
const localBin = fileURLToPath(new URL('../node_modules/.bin', import.meta.url));
const registryText = '# Test registry\n\n## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n\n## End\n';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A durable machine-service as seen from another Mac: lease_id everywhere, bytes only. */
class DurableService {
  readonly requests: Array<{ method: string; path: string; body: any }> = [];
  lease?: { lease_id: string; purpose: string; workspace: string; created_at: number; ttl_hours: number; ttl_expires_at: number };
  /** Someone else holds the machine for this many acquisitions (DC-34). */
  leasedByOthers = 0;
  recordNotFound = false;
  releaseNotFound = 0;
  name = MACHINE;
  machineId?: string;
  grantedName = MACHINE;
  origin = '';
  software: Record<string, unknown> | null = { ...installed };
  readonly server = createServer((req, res) => { void this.handle(req, res).catch(error => this.respond(res, 500, { error: String(error) })); });
  constructor(readonly root: string) {}
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address(); assert.ok(addr && typeof addr !== 'string');
    return this.origin = `http://127.0.0.1:${addr.port}`;
  }
  respond(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
  record() {
    const l = this.lease;
    return { name: this.name, kind: 'durable', instance: this.name, ...(this.machineId ? { machine_id: this.machineId } : {}), state: l ? 'leased' : 'available', lease_id: l?.lease_id ?? null, purpose: l?.purpose ?? null, image: null, image_kind: null, created_at: l?.created_at ?? null, ttl_hours: l?.ttl_hours ?? null, ttl_expires_at: l?.ttl_expires_at ?? null, grace_until: null, warned: false, env: l ? 'none' : null, ip: null, cpu: 10, memory_mb: 16384, disk_gb: 256, configuration: null, workspace: l?.workspace ?? null, warnings: [], capabilities: { schema_version: 1, software: this.software, permissions: { screen_recording: 'denied', accessibility: 'denied', post_event: 'denied' } } };
  }
  current(name: string, id: unknown) {
    if (name !== this.name && !(name === this.grantedName && id === this.lease?.lease_id)) return { status: 404, error: `unknown machine: ${name}` };
    if (typeof id !== 'string') return { status: 409, error: `lease_id is required for an operation on durable machine ${name}` };
    if (!this.lease || this.lease.lease_id !== id) return { status: 409, error: `lease ${id} is not the current lease of durable machine ${name}` };
  }
  resolve(path: string) { return isAbsolute(path) ? path : join(this.lease!.workspace, 'work', path); }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks), url = new URL(req.url!, 'http://fixture');
    const body = req.headers['content-type'] === 'application/json' && raw.length ? JSON.parse(raw.toString()) : undefined;
    this.requests.push({ method: req.method!, path: url.pathname + url.search, body });
    if (url.pathname === '/health') return this.respond(res, 200, { ok: true, service: 'machine-service', instance: this.name, ...(this.machineId ? { machine_id: this.machineId } : {}), kinds: ['durable'] });
    if (url.pathname === '/machines') return this.respond(res, 200, { machines: { [this.name]: this.record() }, offers: [], limits: { max_macos_running: 0, grace_hours: 6 }, pilot_repo: '', port: 0 });
    if (url.pathname === '/acquire') {
      for (const field of ['image', 'network', 'vnc', 'wait', 'cpu', 'memory_mb', 'disk_gb']) if (body[field] !== undefined) return this.respond(res, 400, { error: `${field} does not apply to a durable machine` });
      if (this.leasedByOthers-- > 0 || this.lease) return this.respond(res, 409, { error: `durable machine leased: ${MACHINE} (purpose other, until later)` });
      const lease_id = randomUUID().replaceAll('-', ''), workspace = join(this.root, 'leases', lease_id), now = Date.now() / 1000;
      for (const folder of ['work', 'tmp']) await mkdir(join(workspace, folder), { recursive: true });
      this.grantedName = this.name;
      this.lease = { lease_id, purpose: body.purpose, workspace, created_at: now, ttl_hours: body.ttl_hours, ttl_expires_at: now + body.ttl_hours * 3600 };
      return this.respond(res, 200, this.record());
    }
    const match = /^\/machines\/([^/]+)(?:\/(exec|push|pull|heartbeat|release|files))?$/.exec(url.pathname);
    if (!match) return this.respond(res, 404, { error: 'not found' });
    const [, name, action] = match;
    if (!action) return !this.recordNotFound && (name === this.name || (name === this.grantedName && url.searchParams.get('lease_id') === this.lease?.lease_id)) ? this.respond(res, 200, this.record()) : this.respond(res, 404, { error: 'not found' });
    const refused = this.current(name, action === 'files' ? url.searchParams.get('lease_id') ?? undefined : body?.lease_id);
    if (refused) return this.respond(res, refused.status, { error: refused.error });
    if (action === 'push' || action === 'pull') return this.respond(res, 409, { error: 'path-based push and pull need a loopback client; a host path means nothing on another Mac (use PUT or GET /machines/<name>/files)' });
    if (action === 'files') {
      const target = this.resolve(url.searchParams.get('path')!);
      if (req.method === 'PUT') {
        const digest = createHash('sha256').update(raw).digest('hex');
        if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['x-content-sha256'] !== digest) return this.respond(res, 400, { error: 'digest mismatch; nothing was written' });
        await writeFile(target, raw);
        return this.respond(res, 200, { name, vm: name, pushed: target, to: target, bytes: raw.length, sha256: digest, content: 'file' });
      }
      const bytes = await readFile(target);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-sha256': createHash('sha256').update(bytes).digest('hex'), 'x-content-name': target.split('/').at(-1)! });
      return res.end(bytes);
    }
    if (action === 'heartbeat') { this.lease!.ttl_expires_at = Date.now() / 1000 + body.ttl_hours * 3600; return this.respond(res, 200, this.record()); }
    if (action === 'release') {
      if (this.releaseNotFound-- > 0) return this.respond(res, 404, { error: 'not found' });
      const { lease_id, workspace } = this.lease!; this.lease = undefined;
      await rm(workspace, { recursive: true, force: true });
      return this.respond(res, 200, { name, lease_id, released: true, reason: body.reason, hygiene: { lease_id, name, stopped: [], swept: [], failures: [], workspace: { path: workspace, kept: false, removed: true } } });
    }
    const argv: string[] = body.argv;
    const response = await new Promise<{ rc: number; output: string }>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: join(this.lease!.workspace, 'work'), env: { PATH: `${localBin}:${process.env.PATH}`, HOME: this.root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ rc: code ?? 1, output }));
    });
    this.respond(res, 200, { name, vm: name, ...response, output: response.output.slice(-64000) });
  }
  async close() { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

/** A loopback instance with no durable machine, so the durable one is found only through Consul. */
function virtualOnly() {
  return { baseUrl: 'http://localhost:6240', list: async () => ({ machines: {}, limits: { max_macos_running: 2, grace_hours: 6 }, pilot_repo: '', port: 6240 }), health: async () => ({ ok: true, service: 'machine-service' }) } as any;
}

async function fixture(t: TestContext, patch: Partial<ManagerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-durable-')));
  const registryPath = join(root, 'AGENTS.md'); await writeFile(registryPath, registryText);
  const service = new DurableService(root), origin = await service.start();
  // The fake cua-driver answers `permissions status --json` from permissions.json, and takes a constant screenshot.
  const permissions = join(root, 'permissions.json'), driver = join(root, 'fake-cua');
  const setPermissions = (answer: { code: number; stdout: string }) => writeFile(permissions, JSON.stringify(answer));
  await setPermissions({ code: 0, stdout: daemon() });
  await writeFile(driver, `#!${process.execPath}\nconst fs=require('node:fs');const [a,b,c]=process.argv.slice(2);if(a==='permissions'&&b==='status'&&c==='--json'){const p=JSON.parse(fs.readFileSync(${JSON.stringify(permissions)},'utf8'));process.stdout.write(p.stdout);process.exit(p.code);}if(a!=='call'||b!=='get_desktop_state'||c!=='--json')process.exit(99);const o=JSON.parse(process.argv[5]);fs.appendFileSync(${JSON.stringify(join(root, 'captures.jsonl'))},JSON.stringify(o)+'\\n');fs.writeFileSync(o.screenshot_out_file,Buffer.from('${png}','base64'));console.log(JSON.stringify({screenshot_file_path:o.screenshot_out_file}));`);
  await chmod(driver, 0o700);
  const options: ManagerOptions = { project: root, sessionId: randomUUID(), stateRoot: join(root, 'state'), outputRoot: join(root, 'packages'), registry: new Registry(registryPath), vm: virtualOnly(), runtimeBundle: bundle, heartbeatMs: 60000, captureReadyWaitMs: 1000, captureReadyRetryMs: 50, capacityRetryMs: 20, discovery: 'consul', consulFetch: async () => [{ Node: { Node: 'fixture' }, Service: { Address: '127.0.0.1', Port: Number(new URL(service.origin).port), Meta: { instance: service.name, ...(service.machineId ? { machine_id: service.machineId } : {}) } } }], ...patch };
  const manager = new RelayManager(options);
  t.after(async () => { await manager.release().catch(() => {}); await manager.cleanup('test teardown'); await service.close(); await rm(root, { recursive: true, force: true }); });
  const acquire = (patch: Partial<AcquireInput> = {}) => manager.acquire({ machine: MACHINE, task: 'durable', extractions: [{ name: 'artifact', path: 'artifact.txt' }], ttlHours: 0.5, ...patch });
  const stage = () => manager.stage({ cuaDriver: driver, nodePath: process.execPath });
  return { root, origin, service, manager, acquire, stage, setPermissions, registryPath };
}

test('a durable machine through the relay tools: acquire → stage → run → finish, lease_id on every call, bytes only', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const acquired: any = await f.acquire();
  assert.equal(acquired.machine, MACHINE); assert.equal(acquired.kind, 'durable'); assert.equal(acquired.network, 'lan');
  const lease = f.service.lease!;
  assert.equal(acquired.guestRoot, join(lease.workspace, 'work', `mcp-relay-${lease.purpose}`), 'the relay stages under the lease workspace (DC-31)');
  assert.equal(acquired.lease_id, lease.lease_id);
  const acquireBody = f.service.requests.find(r => r.path === '/acquire')!.body;
  assert.deepEqual(Object.keys(acquireBody).sort(), ['env', 'machine', 'purpose', 'ttl_hours']);
  assert.match(await readFile(f.registryPath, 'utf8'), new RegExp(`${MACHINE} \\(durable, ${f.origin.replace(/[.:/]/g, '\\$&')}`));

  const staged: any = await f.stage();
  assert.equal(staged.snapshots.taken, true);
  assert.match(staged.snapshots.reason, /holds Screen Recording/);
  const run: any = await f.manager.run({ because: 'Exercise a durable fixture', language: 'shell', inline: true, code: `printf durable > artifact.txt; echo ran`, step: { id: 'write', title: 'write', expected: 'writes the artifact', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } });
  assert.equal(run.outcome.kind, 'completed', JSON.stringify(run.outcome));
  assert.equal(run.outcome.exitStatus.code, 0);
  assert.equal((await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length >= 2, true, 'before and after snapshots were taken');

  const finished: any = await f.manager.finish();
  assert.ok(finished.packagePath ?? finished.package ?? finished, 'finish delivered a package');
  assert.equal(f.service.lease, undefined, 'the lease was released');
  const lifecycle = JSON.parse(await readFile(`${f.manager.root.replace(/\/state\/.*/, '')}/packages/${lease.purpose}.lifecycle.json`, 'utf8'));
  assert.equal(lifecycle.machine, MACHINE); assert.equal(lifecycle.lease_id, lease.lease_id);
  assert.equal(lifecycle.hygiene.workspace.removed, true, 'the hygiene record is kept (DC-33)');
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);

  const operations = f.service.requests.filter(r => /\/(exec|heartbeat|release|files)/.test(r.path));
  assert.ok(operations.length > 5);
  for (const r of operations) assert.equal(r.path.includes('/files') ? new URL(r.path, 'http://x').searchParams.get('lease_id') : r.body.lease_id, lease.lease_id, `${r.method} ${r.path} carries the lease_id (DC-30)`);
  assert.equal(f.service.requests.some(r => /\/(push|pull)$/.test(r.path)), false, 'no path-based transfer reaches a durable machine (DC-31)');
  assert.ok(f.service.requests.some(r => r.method === 'PUT') && f.service.requests.some(r => r.method === 'GET' && r.path.includes('/files')));
});

test('a durable machine whose cua-driver daemon lacks Screen Recording is staged without snapshots', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.acquire({ extractions: [] });
  await f.setPermissions({ code: 0, stdout: daemon({ screen_recording: false }) });
  const staged: any = await f.stage();
  assert.equal(staged.snapshots.taken, false);
  assert.match(staged.snapshots.reason, /lacks Screen Recording/);
  const run: any = await f.manager.run({ because: 'No snapshots', language: 'shell', inline: true, code: 'echo ok', snapshots: { afterIntervalMs: 0 } });
  assert.equal(run.outcome.kind, 'completed', JSON.stringify(run.outcome));
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/, 'no screenshot was taken');
  // The grant can change on a durable machine: staging again decides again (DC-32).
  await f.setPermissions({ code: 0, stdout: daemon() });
  assert.equal(((await f.stage()) as any).snapshots.taken, true);
  await f.manager.release();
  assert.equal(f.service.lease, undefined);
});

test('a durable machine whose cua-driver daemon is not running, or whose status is unknown, takes no snapshots', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.acquire({ extractions: [] });
  await f.setPermissions({ code: 0, stdout: daemon({ source: { attribution: 'responsible-process' } }) });
  let staged: any = await f.stage();
  assert.equal(staged.snapshots.taken, false); assert.match(staged.snapshots.reason, /daemon is not running/);
  await f.setPermissions({ code: 1, stdout: 'Cua Driver is not installed' });
  staged = await f.stage();
  assert.equal(staged.snapshots.taken, false); assert.match(staged.snapshots.reason, /unknown/);
  await f.manager.release();
});

test('a durable machine leased by someone else is waited for (DC-34), and vnc is refused before anything is asked', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 5000 });
  await assert.rejects(f.acquire({ vnc: true, extractions: [] }), /no console/);
  assert.equal(f.service.requests.some(r => r.path === '/acquire'), false);
  f.service.leasedByOthers = 2;
  const acquired: any = await f.acquire({ extractions: [] });
  assert.ok(acquired.waitedForCapacityMs > 0);
  await f.manager.release();
  assert.equal(f.service.lease, undefined);
});

test('a durable guest restored in a new process finds its owner again and releases', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.acquire({ extractions: [] });
  const sessionId = (f.manager as any).options.sessionId;
  await f.manager.cleanup('simulated restart');
  const again = new RelayManager({ ...(f.manager as any).options, sessionId });
  t.after(() => again.cleanup('test teardown'));
  await again.initialize();
  assert.equal(again.guestStatus().vm, MACHINE);
  await again.release();
  assert.equal(f.service.lease, undefined);
});


test('a durable 404 reconciles through the owner record without consulting Tart (DC-36)', async t => {
  let tartChecks = 0;
  const f = await fixture(t, { verifyDestroyed: async () => { tartChecks++; return true; } });
  const acquired = await f.acquire({ extractions: [] });
  await f.manager.cleanup('simulated restart');
  f.service.recordNotFound = true;
  const again = new RelayManager(f.manager.options);
  t.after(() => again.cleanup('test teardown'));
  await again.initialize();
  assert.equal(tartChecks, 0, 'a durable machine is never checked against Tart');
  assert.equal(again.guestStatus().lease_id, acquired.lease_id);
  assert.equal(again.guestStatus().guestState, 'leased');
  f.service.recordNotFound = false;
  await again.release();
});

test('an unreachable durable owner keeps the saved lease with unknown guest state (DC-36)', async t => {
  let tartChecks = 0;
  const f = await fixture(t, { verifyDestroyed: async () => { tartChecks++; return true; } });
  const acquired = await f.acquire({ extractions: [] });
  await f.manager.cleanup('simulated restart');
  const again = new RelayManager({ ...f.manager.options, consulFetch: async () => [] });
  t.after(() => again.cleanup('test teardown'));
  await assert.rejects(again.initialize(), /ownership retained.*guest state unknown/);
  const saved = JSON.parse(await readFile(join(again.root, 'guests', acquired.guest!, 'lease.json'), 'utf8'));
  assert.equal(saved.lease.lease_id, acquired.lease_id);
  assert.equal(saved.guestState, 'unknown');
  assert.equal(tartChecks, 0);
});

test('a durable release verifies a 404 through the owner record (DC-36)', async t => {
  let tartChecks = 0;
  const f = await fixture(t, { verifyDestroyed: async () => { tartChecks++; return true; } });
  await f.acquire({ extractions: [] });
  f.service.recordNotFound = true;
  await f.manager.release();
  assert.equal(f.service.lease, undefined);
  assert.equal(f.manager.status().guests.length, 0);
  assert.equal(tartChecks, 0);
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});


test('a durable release 404 retries while the owner record still names the lease (DC-36)', async t => {
  const f = await fixture(t);
  await f.acquire({ extractions: [] });
  f.service.recordNotFound = true;
  f.service.releaseNotFound = 1;
  await f.manager.release();
  assert.equal(f.service.lease, undefined);
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/release')).length, 2);
});
