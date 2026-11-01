/**
 * Session-end lifecycle of the shipped MCP server (docs/lifecycle-fixes.md).
 * Each case starts dist/server.mjs over raw stdio pipes, so a test can close
 * the client's side of standard input or standard output on its own. The
 * backend is an in-process fake machine-service or a closed port; the state
 * directory, registry, project and home directory are fresh temporary
 * directories, and Tart is a fake script. No VM, live machine-service or user
 * state is touched.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hash } from '../src/util.js';

const server = resolve('dist/server.mjs');
const registryText = '# Test registry\n\n## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n| foreign | linux | keep-me | another agent | /project | yesterday |\n\n## End\nUnrelated text.\n';
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const gate = () => { let open!: () => void; const promise = new Promise<void>(done => { open = done; }); return { promise, open }; };

/** A minimal machine-service: leases are records; exec, release and heartbeat can be held open by a test. */
class FakeService {
  readonly leases = new Map<string, any>();
  readonly requests: Array<{ method: string; path: string; body: any }> = [];
  heartbeats = 0;
  releaseCalls = 0;
  execHook?: (argv: string[]) => Promise<{ rc: number; output: string }>;
  releaseHook?: () => Promise<void>;
  /** Refuses every acquisition with this status and body, as machine-service refuses one it cannot give. */
  acquireRefusal?: { status: number; body: unknown };
  readonly seen = new Map<string, ReturnType<typeof gate>>();
  readonly http = createServer((req, res) => { void this.handle(req, res).catch(error => this.respond(res, 500, { error: String(error) })); });
  url = '';
  async start() {
    await new Promise<void>(done => this.http.listen(0, '127.0.0.1', done));
    const address = this.http.address(); assert.ok(address && typeof address !== 'string');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  /** Resolves once a request whose path ends with `suffix` has arrived. */
  arrived(suffix: string) { if (!this.seen.has(suffix)) this.seen.set(suffix, gate()); return this.seen.get(suffix)!.promise; }
  respond(res: ServerResponse, status: number, value: unknown) { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = req.url!; this.requests.push({ method: req.method!, path, body });
    for (const [suffix, arrived] of this.seen) if (path.endsWith(suffix)) arrived.open();
    if (path === '/health') return this.respond(res, 200, { ok: true, service: 'machine-service' });
    if (path === '/images') return this.respond(res, 200, { images: { ubuntu2404: { kind: 'linux', base_available: true } }, capacity: { macos_running: 0, macos_limit: 2 } });
    if (path === '/machines') return this.respond(res, 200, { machines: Object.fromEntries(this.leases), limits: { max_macos_running: 2, grace_hours: 1 }, pilot_repo: '/nonexistent', port: 0 });
    if (path === '/acquire') {
      if (this.acquireRefusal) return this.respond(res, this.acquireRefusal.status, this.acquireRefusal.body);
      const vm = `fixture-${randomUUID()}`;
      const lease = { vm, purpose: body.purpose, image: body.image, image_kind: 'linux', env: body.env, state: 'running', created_at: Date.now() / 1000, ttl_expires_at: Date.now() / 1000 + body.ttl_hours * 3600, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null };
      this.leases.set(vm, lease);
      return this.respond(res, 200, lease);
    }
    const match = /^\/machines\/([^/]+)(?:\/(exec|push|pull|heartbeat|release))?$/.exec(path);
    if (!match || !this.leases.has(match[1]!)) return this.respond(res, 404, { error: 'not found' });
    const vm = match[1]!, lease = this.leases.get(vm);
    if (!match[2]) return this.respond(res, 200, lease);
    if (match[2] === 'heartbeat') { this.heartbeats++; return this.respond(res, 200, { ...lease, ttl_hours_remaining: body.ttl_hours }); }
    if (match[2] === 'release') { this.releaseCalls++; await this.releaseHook?.(); this.leases.delete(vm); return this.respond(res, 200, { vm, released: true, reason: body.reason }); }
    if (match[2] === 'exec') return this.respond(res, 200, { vm, ...(await this.execHook?.(body.argv) ?? { rc: 0, output: '' }) });
    return this.respond(res, 400, { error: 'the fake service does not transfer files' });
  }
  async close() { this.http.closeAllConnections(); await new Promise<void>(done => this.http.close(() => done())); }
}

interface Relay {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  send: (message: Record<string, unknown>) => void;
  alive: () => boolean;
  stateRoot: string;
  sessionId: string;
  /** The server's own process: the child itself, or the one a wrapper started. */
  serverPid: () => number | undefined;
}

/** A parent that starts the server on its own standard streams and then just waits, so the test can make the server's parent go away while its standard input stays open. */
const WRAPPER = "const c=require('child_process').spawn(process.execPath,[process.argv[1]],{stdio:'inherit'});process.stderr.write('server-pid '+c.pid+'\\n');setInterval(()=>{},1e6);";
/** Whether a process is still running. */
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-lifecycle-')));
  const project = join(root, 'project'); await mkdir(project);
  const bin = join(root, 'bin'); await mkdir(bin);
  const tart = join(bin, 'tart'); await writeFile(tart, '#!/bin/sh\nprintf "[]"\n'); await chmod(tart, 0o700);
  const registry = join(root, 'registry.md'); await writeFile(registry, registryText);
  const children: ChildProcessWithoutNullStreams[] = [];
  const servers: number[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const pid of servers) if (running(pid)) process.kill(pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  /** Start the shipped server with only the variables this test sets: no inherited environment selection, state or registry. */
  const start = async (url: string, sessionId: string | undefined = `lifecycle-${randomUUID()}`, extra: Record<string, string> = {}, { wrapped = false } = {}): Promise<Relay> => {
    const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, HOME: root, TART: tart, MCP_RELAY_URL: url, MCP_RELAY_STATE_DIR: join(root, 'state'), MCP_RELAY_REGISTRY: registry, MCP_RELAY_PROJECT: project, ...(sessionId ? { MCP_RELAY_SESSION: sessionId } : {}), ...extra };
    const child = spawn(process.execPath, wrapped ? ['-e', WRAPPER, server] : [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '', nextId = 1;
    const waiting = new Map<number, (message: any) => void>();
    child.stdout.on('data', data => {
      stdout += data;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        try { const message = JSON.parse(line); waiting.get(message.id)?.(message); } catch { /* not a JSON-RPC line */ }
      }
    });
    child.stderr.on('data', data => { stderr += data; const pid = /server-pid (\d+)/.exec(stderr)?.[1]; if (pid && !servers.includes(Number(pid))) servers.push(Number(pid)); });
    child.stdin.on('error', () => {});
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.on('exit', (code, signal) => done({ code, signal })));
    const send = (message: Record<string, unknown>) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
    const request = (method: string, params: unknown) => { const id = nextId++; const answer = new Promise<any>(done => waiting.set(id, done)); send({ id, method, params }); return answer; };
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '0' } });
    send({ method: 'notifications/initialized' });
    const call = async (name: string, args: Record<string, unknown> = {}) => (await request('tools/call', { name, arguments: args })).result;
    const alive = () => child.exitCode === null && child.signalCode === null;
    const serverPid = () => wrapped ? Number(/server-pid (\d+)/.exec(stderr)?.[1]) || undefined : child.pid;
    return { child, stderr: () => stderr, exited, call, send, alive, stateRoot: join(root, 'state'), sessionId: sessionId ?? '', serverPid };
  };
  const service = async () => { const fake = new FakeService(); await fake.start(); t.after(() => fake.close()); return fake; };
  /** The durable ownership record of a session, and the lifecycle events of its enclosure. */
  const leaseFile = (relay: Relay, guest = 'lifecycle-1') => join(relay.stateRoot, hash(relay.sessionId).slice(0, 32), 'guests', guest, 'lease.json');
  const lease = async (relay: Relay, guest?: string) => JSON.parse(await readFile(leaseFile(relay, guest), 'utf8'));
  const events = async (hostRoot: string) => {
    const directory = join(hostRoot, 'host', 'events');
    return Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  };
  return { root, project, registry, start, service, leaseFile, lease, events };
}

/** Resolves with the exit, or with undefined when the process is still alive after `ms`. */
const exitWithin = (relay: Relay, ms: number) => Promise.race([relay.exited, sleep(ms).then(() => undefined)]);
const acquireArgs = { task: 'lifecycle', image: 'ubuntu2404', extractions: [] };

test('R1: the server exits when its client closes stdin after a call that took the owner lock', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const relay = await f.start('http://127.0.0.1:9'); // nothing listens there
  const probe = await relay.call('relay_probe', { scope: 'guest', guest: 'none-1' });
  assert.equal(probe.isError, true, 'no lease is owned, but the call ran manager init and took the owner lock');
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 5000);
  assert.ok(exit, 'the server must end its session when stdin reaches end of file');
  assert.equal(exit.code, 0, relay.stderr());
});

test('R1: closing stdin with an owned lease pauses renewal, retains the VM and exits', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url);
  const acquired = await relay.call('relay_acquire', acquireArgs);
  assert.equal(acquired.isError, false, acquired.content[0].text);
  const owned = await f.lease(relay);
  assert.equal(owned.active, true);
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 5000);
  assert.ok(exit, 'the server must end its session when stdin reaches end of file');
  assert.equal(exit.code, 0, relay.stderr());
  const after = await f.lease(relay);
  assert.equal(after.active, false, 'lease.json records that renewal stopped');
  assert.equal(after.lease.vm, owned.lease.vm, 'the VM stays owned for an explicit finish or release');
  const paused = (await f.events(owned.hostRoot)).find(event => event.kind === 'renewal-paused');
  assert.ok(paused, 'a renewal-paused event is written');
  assert.match(paused.details.reason, /session/i);
  assert.equal(f.fake.releaseCalls, 0, 'session end never releases the VM');
  assert.equal(f.fake.leases.has(owned.lease.vm), true);
  const heartbeats = f.fake.heartbeats; await sleep(500);
  assert.equal(f.fake.heartbeats, heartbeats, 'no heartbeat after the session ended');
});

test('R1: relay_status after a restart lists the guests the session holds, before any other call', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const session = `lifecycle-${randomUUID()}`;
  const first = await f.start(f.fake.url, session);
  const acquired = await first.call('relay_acquire', acquireArgs);
  assert.equal(acquired.isError, false, acquired.content[0].text);
  first.child.stdin.end(); await exitWithin(first, 5000);
  const second = await f.start(f.fake.url, session);
  const status = JSON.parse((await second.call('relay_status')).content[0].text);
  assert.deepEqual(status.guests.map((guest: any) => guest.guest), ['lifecycle-1'], 'the restarted relay reports the guest it still owns');
  await second.call('relay_release', { guest: 'lifecycle-1' });
  second.child.stdin.end(); await second.exited;
});

test('H6: closing stdin sends one final renewal for the lease\'s remaining TTL, after renewing only a short window', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url);
  const acquired = await relay.call('relay_acquire', { ...acquireArgs, ttlHours: 2 });
  assert.equal(acquired.isError, false, acquired.content[0].text);
  const ttls = (suffix: string) => f.fake.requests.filter(r => r.path.endsWith(suffix)).map(r => r.body.ttl_hours as number);
  assert.deepEqual(ttls('/acquire'), [0.25], 'acquire asks for the 15-minute renewal window');
  const before = ttls('/heartbeat').length;
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 5000);
  assert.ok(exit, 'the server must end its session when stdin reaches end of file');
  const final = ttls('/heartbeat').slice(before);
  assert.equal(final.length, 1, 'one final renewal at session end');
  assert.ok(final[0]! > 1.99 && final[0]! <= 2, `the final renewal covers the lease's remaining TTL (${final[0]} h)`);
  assert.equal(f.fake.releaseCalls, 0, 'session end never releases the VM');
});

test('R1: closing stdin during an in-flight release lets the release complete before exit', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url);
  assert.equal((await relay.call('relay_acquire', acquireArgs)).isError, false);
  const owned = await f.lease(relay);
  const hold = gate(); f.fake.releaseHook = () => hold.promise;
  const released = relay.call('relay_release', { guest: 'lifecycle-1' });
  await f.fake.arrived('/release');
  relay.child.stdin.end();
  await sleep(1000);
  assert.equal(relay.alive(), true, 'shutdown waits for the in-flight release instead of cutting it short');
  hold.open();
  const exit = await exitWithin(relay, 5000);
  assert.ok(exit, 'the server exits once the in-flight release has completed');
  assert.equal(exit.code, 0, relay.stderr());
  assert.equal((await released).isError, false);
  assert.equal(await readFile(f.leaseFile(relay), 'utf8'), 'null\n', 'the release completed and removed ownership');
  assert.equal(f.fake.leases.has(owned.lease.vm), false);
  assert.equal(await readFile(f.registry, 'utf8'), registryText, 'the registry row was removed');
});

/** A fixture with a fake machine-service. */
async function withService(t: TestContext) { const f = await fixture(t); return { ...f, fake: await f.service() }; }

test('R1: shutdown behind an operation that never settles is bounded by the grace period and still pauses renewal', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_SHUTDOWN_GRACE_MS: '500' });
  assert.equal((await relay.call('relay_acquire', acquireArgs)).isError, false);
  const owned = await f.lease(relay);
  f.fake.execHook = () => new Promise(() => {}); // a guest command whose answer never comes
  void relay.call('relay_script', { guest: 'lifecycle-1', diagnostic: true, language: 'shell', inline: true, code: '/bin/true' });
  await f.fake.arrived('/exec');
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 10000);
  assert.ok(exit, 'shutdown gives up waiting after the grace period');
  assert.equal(exit.code, 0, relay.stderr());
  assert.equal((await f.lease(relay)).active, false);
  assert.ok((await f.events(owned.hostRoot)).some(event => event.kind === 'renewal-paused'));
  assert.equal(f.fake.releaseCalls, 0);
});

test('R2: a response written after the client closed its reader ends the session with cleanup, not an unhandled EPIPE', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url);
  assert.equal((await relay.call('relay_acquire', acquireArgs)).isError, false);
  const owned = await f.lease(relay);
  assert.equal(owned.active, true);
  const hold = gate();
  f.fake.execHook = async () => { await hold.promise; return { rc: 1, output: 'fixture failure after the client left' }; };
  void relay.call('relay_script', { guest: 'lifecycle-1', diagnostic: true, language: 'shell', inline: true, code: '/bin/false' });
  await f.fake.arrived('/exec');
  relay.child.stdout.destroy(); // the client's read side is gone; standard input stays open
  await sleep(200);
  hold.open(); // the operation fails and the server writes its result to the closed pipe
  const exit = await exitWithin(relay, 10000);
  assert.ok(exit, 'the server ends the session');
  assert.doesNotMatch(relay.stderr(), /EPIPE|Unhandled 'error' event/, 'a closed standard output is a session end, not a crash');
  assert.equal(exit.code, 0, relay.stderr());
  const after = await f.lease(relay);
  assert.equal(after.active, false, 'lease.json records that renewal stopped');
  assert.equal(after.lease.vm, owned.lease.vm, 'the VM stays owned for an explicit finish or release');
  assert.ok((await f.events(owned.hostRoot)).some(event => event.kind === 'renewal-paused'), 'a renewal-paused event is written');
  assert.equal(f.fake.releaseCalls, 0);
});

test('R3: relay_release on a session that owns no lease says so instead of looking like a release', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const relay = await f.start('http://127.0.0.1:9');
  const result = await relay.call('relay_release', { guest: 'lifecycle-1' });
  const text = result.content[0].text;
  assert.equal(result.isError, true, `a release that released nothing must not look like success: ${text}`);
  assert.match(text, /owns no lease/);
  assert.match(text, /MCP_RELAY_SESSION/, 'the result names how an earlier session\'s lease can be reached');
  relay.child.stdin.end(); await relay.exited;
});

test('R3 (session identity): a restarted server with the default random session identity cannot see the lease of the process before it', { timeout: 30000, todo: 'waiting for the owner\'s decision: the default session identity is a fresh random UUID per server process (src/server.ts), so this documents the current behavior' }, async t => {
  const f = await withService(t);
  const first = await f.start(f.fake.url, undefined);
  assert.equal((await first.call('relay_acquire', acquireArgs)).isError, false);
  const [vm] = [...f.fake.leases.keys()];
  first.child.kill('SIGTERM'); await first.exited;
  const second = await f.start(f.fake.url, undefined);
  await second.call('relay_release', { guest: 'lifecycle-1' });
  const status = JSON.parse((await second.call('relay_status')).content[0].text);
  assert.equal(status.active, false, 'the new process owns nothing');
  assert.equal(f.fake.releaseCalls, 0, 'nothing was released');
  assert.equal(f.fake.leases.has(vm!), true, 'the earlier lease is still held at the backend, reachable only through its TTL or its old session identity');
  second.child.stdin.end(); await second.exited;
});

/** Two guests in one session, acquired over the shipped server. */
async function twoGuests(f: Awaited<ReturnType<typeof withService>>, relay: Relay) {
  for (const guest of ['lifecycle-1', 'lifecycle-2']) {
    const acquired = await relay.call('relay_acquire', acquireArgs);
    assert.equal(acquired.isError, false, acquired.content[0].text);
    assert.equal(JSON.parse(acquired.content[0].text).guest, guest);
  }
  assert.equal(f.fake.leases.size, 2);
  return [await f.lease(relay, 'lifecycle-1'), await f.lease(relay, 'lifecycle-2')];
}
/** Both guests were released through their release path: VMs gone, records emptied, registry rows removed, and each guest's evidence says why. */
async function assertReleased(f: Awaited<ReturnType<typeof withService>>, relay: Relay, owned: any[]) {
  assert.equal(f.fake.releaseCalls, 2, 'each guest was released once');
  assert.equal(f.fake.leases.size, 0);
  for (const guest of ['lifecycle-1', 'lifecycle-2']) assert.equal(await readFile(f.leaseFile(relay, guest), 'utf8'), 'null\n', `${guest} holds no record`);
  assert.equal(await readFile(f.registry, 'utf8'), registryText, 'both registry rows were removed');
  for (const record of owned) {
    const lifecycle = JSON.parse(await readFile(`${record.hostRoot}.lifecycle.json`, 'utf8'));
    assert.equal(lifecycle.released, true); assert.equal(lifecycle.reason, 'released');
    assert.ok((await f.events(record.hostRoot)).some(event => event.kind === 'exit-release'), 'the release says the session ended');
  }
}

test('DC-21: with MCP_RELAY_ON_EXIT=release, closing stdin releases both guests the session holds, then the server exits', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_ON_EXIT: 'release' });
  const owned = await twoGuests(f, relay);
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 15000);
  assert.ok(exit, 'the server exits once the guests are released');
  assert.equal(exit.code, 0, relay.stderr());
  await assertReleased(f, relay, owned);
});

test('DC-21: with MCP_RELAY_ON_EXIT=release, SIGTERM releases both guests, then the server exits', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_ON_EXIT: 'release' });
  const owned = await twoGuests(f, relay);
  relay.child.kill('SIGTERM');
  const exit = await exitWithin(relay, 15000);
  assert.ok(exit, 'the server exits once the guests are released');
  assert.equal(exit.code, 0, relay.stderr());
  await assertReleased(f, relay, owned);
});

test('DC-21: with MCP_RELAY_ON_EXIT=release, the parent process going away releases both guests even while stdin stays open', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_ON_EXIT: 'release' }, { wrapped: true });
  const owned = await twoGuests(f, relay);
  const pid = relay.serverPid(); assert.ok(pid, relay.stderr());
  relay.child.kill('SIGKILL'); // the parent goes away; the test still holds the server's standard input open
  const deadline = Date.now() + 15000;
  while (running(pid) && Date.now() < deadline) await sleep(100);
  assert.equal(running(pid), false, 'the server ends its session when its parent goes away');
  await assertReleased(f, relay, owned);
});

test('DC-21: by default (pause) closing stdin keeps both guests and pauses their renewal', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url);
  const owned = await twoGuests(f, relay);
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 10000);
  assert.ok(exit); assert.equal(exit.code, 0, relay.stderr());
  assert.equal(f.fake.releaseCalls, 0, 'session end never releases a VM by default');
  for (const [index, guest] of ['lifecycle-1', 'lifecycle-2'].entries()) {
    const after = await f.lease(relay, guest);
    assert.equal(after.active, false, `${guest} renewal paused`); assert.equal(after.lease.vm, owned[index].lease.vm);
    assert.equal(f.fake.leases.has(after.lease.vm), true);
    assert.ok((await f.events(after.hostRoot)).some(event => event.kind === 'renewal-paused'));
  }
  assert.notEqual(await readFile(f.registry, 'utf8'), registryText, 'both guests stay registered');
});

test('DC-21: with MCP_RELAY_ON_EXIT=release, a guest operation that never answers delays the release only for the grace period', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_ON_EXIT: 'release', MCP_RELAY_SHUTDOWN_GRACE_MS: '500' });
  const owned = await twoGuests(f, relay);
  f.fake.execHook = () => new Promise(() => {}); // a guest command whose answer never comes
  void relay.call('relay_script', { guest: 'lifecycle-1', diagnostic: true, language: 'shell', inline: true, code: '/bin/true' });
  await f.fake.arrived('/exec');
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 20000);
  assert.ok(exit, 'the release is bounded'); assert.equal(exit.code, 0, relay.stderr());
  await assertReleased(f, relay, owned);
});

test('DC-22: with MCP_RELAY_ON_EXIT=release, a session that ends while relay_acquire waits for capacity exits at once with nothing acquired', { timeout: 30000 }, async t => {
  const f = await withService(t);
  const relay = await f.start(f.fake.url, undefined, { MCP_RELAY_ON_EXIT: 'release', MCP_RELAY_CAPACITY_WAIT: '600' });
  const owned = await twoGuests(f, relay);
  f.fake.acquireRefusal = { status: 409, body: { error: 'macOS VM limit reached (2 active); release one first' } };
  const waiting = relay.call('relay_acquire', acquireArgs);
  await f.fake.arrived('/acquire');
  const deadline = Date.now() + 5000;
  while (!JSON.parse((await relay.call('relay_status')).content[0].text).guests.some((guest: any) => guest.waitingForCapacity) && Date.now() < deadline) await sleep(50);
  const started = Date.now();
  relay.child.stdin.end();
  const exit = await exitWithin(relay, 10000);
  assert.ok(exit, 'the server exits without waiting out the capacity wait'); assert.equal(exit.code, 0, relay.stderr());
  assert.ok(Date.now() - started < 8000, `exit took ${Date.now() - started} ms`);
  void waiting;
  await assertReleased(f, relay, owned);
  assert.equal(f.fake.requests.filter(r => r.path === '/acquire').length, 3, 'the waiting acquisition was asked once and never granted');
  assert.equal(await readFile(f.leaseFile(relay, 'lifecycle-3'), 'utf8'), 'null\n', 'the waiting guest holds no record');
});
