import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { RelayManager, type AcquireInput, type ManagerOptions, type RunInput } from '../src/manager.js';
import { Registry } from '../src/registry.js';
import { VmService, VmServiceError, capacityRefusal, type VmLease } from '../src/vm-service.js';
import { verifyDeliveredPackage } from '../src/package.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { relayCall } from '../src/surface.js';
import type { RelayInput } from '../src/schema.js';

/**
 * A stand-in for a runtime's tool binding, shaped like pi's: validate through
 * the surface, obtain the manager only then, return an image-bearing result as
 * structured details with its error flag, and signal any other failure by throwing.
 */
type ExtensionContext = Record<string, never>;
function createRelayTool(get: (ctx: ExtensionContext) => RelayManager) {
  return {
    name: 'relay',
    async execute(id: string, raw: unknown, signal?: AbortSignal, _update?: unknown, ctx: ExtensionContext = {}) {
      const result = await relayCall(() => get(ctx), raw, { signal, toolCallId: id });
      if (result.imageDelivery) return { content: [{ type: 'text' as const, text: result.text }, ...(result.image ? [result.image] : [])], details: result.details as any };
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: 'text' as const, text: result.text }], details: result.details };
    },
  };
}
/** The JSON a relay text result carries: an image-bearing result leads with its identity line. */
function relayJson(text: string): any {
  const lines = text.split('\n');
  return JSON.parse(lines[0].startsWith('{"imageDelivery"') ? lines.slice(1).join('\n') : text);
}

const registryText = '# Test registry\n\n## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n| foreign | linux | keep-me | another agent | /project | yesterday |\n\n## End\nUnrelated text.\n';
// Asymmetric 3×2 RGB fixture with valid PNG chunk CRCs (decoded by production prepareImage).
const png = (() => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 255, 255, 128, 0, 64]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
})();
const bundle = fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
const localBin = fileURLToPath(new URL('../node_modules/.bin', import.meta.url));
const reason = 'Exercise isolated protocol fixtures, never the real desktop';
/** The guest every fixture's first acquisition names: its task and the counter 1 (DC-20). */
const G = 'manager-test-1';
const acquireInput = (patch: Partial<AcquireInput> = {}): AcquireInput => ({ image: 'ubuntu2404', task: 'manager-test', extractions: [], ...patch });
/** A command as a shell script (DC-26): each argument single-quoted. */
const sh = (argv: readonly string[]): string => argv.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
const operation = (id: string, patch: Partial<RunInput> = {}): RunInput => ({ because: reason, language: 'shell', inline: true, code: sh([process.execPath, '-e', 'console.log("test output")']), step: { id, title: id, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 }, ...patch });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
/** A guest's durable ownership record: `guests/<guest>/lease.json` in the session's state directory (DC-20). */
const leaseFile = (manager: RelayManager, guest = G) => join(manager.root, 'guests', guest, 'lease.json');
/** The session's first guest, for the tests that reach its renewal internals. */
const guestOf = (manager: RelayManager): any => [...(manager as any).guests.values()][0];
/** A run names its after-image as pending; relay_image waits for its background download and shows it (docs/screenshot-delivery.md §10). */
async function shown(manager: RelayManager, run: { imageDelivery?: { status: string; image?: any } }) {
  assert.equal(run.imageDelivery?.status, 'pending', JSON.stringify(run.imageDelivery));
  const image = await manager.image({ source: 'reference', imageId: run.imageDelivery!.image!.imageId });
  assert.equal(image.status, 'attached', JSON.stringify(image));
  assert.deepEqual(image.image, run.imageDelivery!.image, 'relay_image shows the image the run named');
  return image.image!;
}

/** Implements the actual HTTP contract. Only test-authored Node/transfer commands
 * run locally; the CUA executable ONLY writes a constant PNG and refuses input.
 * No VM, real desktop, installed browser, or user registry is touched. */
class FixtureService {
  readonly leases = new Map<string, VmLease>();
  readonly requests: Array<{ method: string; path: string; body: any }> = [];
  readonly guestRoots = new Set<string>();
  readonly released = deferred();
  readonly heartbeatDuringExec = deferred();
  heartbeatCount = 0;
  failHeartbeat = false;
  failGet = false;
  heartbeatHook?: () => Promise<void>;
  hideLeases = false;
  loseAcquireResponse = false;
  malformedReceiverResponse = false;
  releaseFailures = 0;
  releaseCalls = 0;
  failPush = false;
  corruptPull = false;
  screenshotPullFailures = 0;
  /** Fails every archive pull, so a verified pull falls back to the per-file pull (AD-10). */
  archivePullFails = false;
  /** Fails the next archive pulls, as a lost session link would (AD-4). */
  archivePullFailures = 0;
  acquireHook?: () => Promise<void>;
  /** The image catalog `/applications` serves: by default ubuntu2404 lists cua-driver, so runs take snapshots as before (DC-13). */
  catalog: unknown = { schemaVersion: 1, images: [{ image: 'ubuntu2404', os: 'linux', architecture: 'arm64', applications: [{ id: 'dpkg:cua-driver', name: 'cua-driver', aliases: [], version: '1.0' }, { id: 'dpkg:nodejs', name: 'Node.js', aliases: ['node'], version: '22.0.0' }] }] };
  /** Fails `/applications`, as an unreachable or older catalog would. */
  catalogFails = false;
  /** The guest has no Node.js on PATH: `node --version` exits 127, as a shell would. */
  noNode = false;
  /** Refuses every acquisition with this status and body, as vm-service refuses one it cannot give. */
  acquireRefusal?: { status: number; body: unknown };
  /** How many acquisitions acquireRefusal refuses before the next is granted; every one when undefined. */
  acquireRefusals?: number;
  receiverHook?: () => Promise<void>;
  /** Runs before any pull; a test can hold one open. */
  pullHook?: (remote: string) => Promise<void>;
  /** Runs before any guest command; a test can hold one open. */
  execHook?: (argv: string[]) => Promise<void>;
  receiverActive = 0;
  maxReceiverActive = 0;
  receiverCalls = 0;
  readonly server = createServer((req, res) => { void this.handle(req, res).catch(error => this.respond(res, 500, { error: String(error) })); });
  constructor(readonly root: string) {}
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address(); assert.ok(addr && typeof addr !== 'string');
    return new VmService({ baseUrl: `http://127.0.0.1:${addr.port}`, timeoutMs: 15000 });
  }
  respond(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = req.url!; this.requests.push({ method: req.method!, path, body });
    if (path === '/health') return this.respond(res, 200, { ok: true, service: 'fixture-only' });
    if (path === '/applications') return this.catalogFails ? this.respond(res, 503, { error: 'fixture catalog unavailable' }) : this.respond(res, 200, this.catalog);
    if (path === '/images') return this.respond(res, 200, { images: { ubuntu2404: { kind: 'linux', base_available: true }, missing: { base_available: false } }, capacity: { macos_running: 0, macos_limit: 2 } });
    if (path === '/vms') return this.respond(res, 200, { vms: this.hideLeases ? {} : Object.fromEntries(this.leases), limits: { max_macos_running: 2, grace_hours: 1 }, pilot_repo: this.root, port: 0 });
    if (path === '/acquire') {
      if (this.acquireRefusal && (this.acquireRefusals === undefined || this.acquireRefusals-- > 0)) return this.respond(res, this.acquireRefusal.status, this.acquireRefusal.body);
      const vm = `fixture-${randomUUID()}`;
      const lease: VmLease = { vm, purpose: body.purpose, image: body.image, image_kind: 'linux', env: body.env, state: 'running', created_at: Date.now() / 1000, ttl_expires_at: Date.now() / 1000 + body.ttl_hours * 3600, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null };
      this.leases.set(vm, lease); await this.acquireHook?.();
      if (this.loseAcquireResponse) { res.destroy(); return; }
      return this.respond(res, 200, lease);
    }
    const match = /^\/vms\/([^/]+)(?:\/(exec|push|pull|heartbeat|release))?$/.exec(path);
    if (!match || !this.leases.has(match[1])) return this.respond(res, 404, { error: 'not found' });
    const vm = match[1], lease = this.leases.get(vm)!;
    if (!match[2]) return this.respond(res, this.failGet ? 503 : 200, this.failGet ? { error: 'fixture lease lookup unavailable' } : lease);
    if (match[2] === 'heartbeat') {
      this.heartbeatCount++; if (this.receiverActive) this.heartbeatDuringExec.resolve();
      await this.heartbeatHook?.();
      if (this.failHeartbeat) return this.respond(res, 503, { error: 'fixture heartbeat lost' });
      // As vm-service does, a renewal moves the expiry to now + ttl_hours.
      lease.ttl_expires_at = Date.now() / 1000 + body.ttl_hours * 3600;
      return this.respond(res, 200, { ...lease, ttl_hours_remaining: body.ttl_hours });
    }
    if (match[2] === 'release') {
      this.releaseCalls++;
      if (this.releaseFailures-- > 0) return this.respond(res, 503, { error: 'fixture destruction unavailable' });
      this.leases.delete(vm); this.respond(res, 200, { vm, released: true, reason: body.reason }); this.released.resolve(); return;
    }
    if (match[2] === 'push') {
      if (this.failPush) return this.respond(res, 500, { error: 'fixture push failed' });
      await copyFile(body.local_path, body.remote_path);
      return this.respond(res, 200, { vm, pushed: body.local_path, to: body.remote_path });
    }
    if (match[2] === 'pull') {
      await this.pullHook?.(body.remote_path);
      if (body.remote_path.includes('/.archive-') && (this.archivePullFails || this.archivePullFailures-- > 0)) return this.respond(res, 503, { error: 'fixture archive transfer unavailable' });
      if (body.remote_path.endsWith('.png') && this.screenshotPullFailures > 0) {
        this.screenshotPullFailures--; return this.respond(res, 503, { error: 'fixture screenshot transfer unavailable' });
      }
      await copyFile(body.remote_path, body.local_path);
      if (this.corruptPull && body.remote_path.endsWith('artifact.txt')) await writeFile(body.local_path, 'corruption');
      if (this.corruptPull && body.remote_path.includes('/.archive-')) await appendFile(body.local_path, 'corruption');
      return this.respond(res, 200, { vm, pulled: body.remote_path, to: body.local_path });
    }
    const argv: string[] = body.argv;
    if (argv[0] === 'cua-driver' && argv.length === 2 && argv[1] === '--version') return this.respond(res, 200, { vm, rc: 127, output: 'fixture cua-driver not installed' });
    if (this.noNode && argv[0] === 'node') return this.respond(res, 200, { vm, rc: 127, output: 'env: node: No such file or directory' });
    // relay_probe's runtime facts (DC-23): the fixture guest has Python and no tsx on vm-service's PATH.
    if (argv[0] === 'tsx' && argv.length === 2 && argv[1] === '--version') return this.respond(res, 200, { vm, rc: 127, output: 'env: tsx: No such file or directory' });
    if (argv[0] === 'python3' && argv.length === 2 && argv[1] === '--version') return this.respond(res, 200, { vm, rc: 0, output: 'Python 3.12.0' });
    assert.ok(['node', process.execPath, '/bin/mkdir', '/bin/sh', '/usr/bin/env', join(this.root, 'fake-cua')].includes(argv[0]), `Unexpected fixture executable: ${argv[0]}`);
    // A diagnostic shell script runs as /bin/sh -c, inside the staged workspace once staged (DC-26); the probe runs `exit 0`.
    if (argv[0] === '/bin/sh' && argv.length > 3) { assert.equal(argv[2], 'cd "$1" || exit; shift; exec "$@"'); assert.ok(argv[4].startsWith('/var/tmp/')); assert.deepEqual(argv.slice(5, 7), ['/bin/sh', '-c']); }
    else if (argv[0] === '/bin/sh') assert.equal(argv[1], '-c');
    if (argv[0] === '/bin/mkdir') {
      for (const path of argv.slice(2)) {
        const root = /^\/var\/tmp\/[^/]+-mcp-relay-(relay-manager-test-[a-f0-9-]+)(?:\/|$)/.exec(path);
        assert.ok(root, `Unexpected fixture directory: ${path}`);
        assert.equal(root[1], lease.purpose);
        this.guestRoots.add(path.split('/').slice(0, 4).join('/'));
      }
    }
    await this.execHook?.(argv);
    const isReceiver = argv[0] === '/usr/bin/env';
    if (isReceiver) { this.receiverCalls++; this.receiverActive++; this.maxReceiverActive = Math.max(this.maxReceiverActive, this.receiverActive); }
    try {
      if (isReceiver) await this.receiverHook?.();
      const response = await new Promise<{ rc: number; output: string }>((resolve, reject) => {
        // The receiver finds the language runtimes on the guest's PATH: python3 from the host, tsx from this checkout.
        const child = spawn(argv[0], argv.slice(1), { cwd: this.root, env: { PATH: `${localBin}:${process.env.PATH}`, HOME: this.root }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
        child.on('error', reject); child.on('close', code => resolve({ rc: code ?? 1, output }));
      });
      if (isReceiver && this.malformedReceiverResponse) {
        const request = await json(argv.at(-1)!);
        const guestRoot = argv.find(arg => arg.startsWith('RELAY_RUNTIME_ROOT='))!.slice('RELAY_RUNTIME_ROOT='.length);
        await writeFile(join(guestRoot, 'state/receiver/receipts', `${request.executionId}.json`), JSON.stringify({ executionId: 'wrong-identity', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } }));
      }
      this.respond(res, 200, { vm, ...response, output: response.output.slice(-64000) });
    } finally { if (isReceiver) this.receiverActive--; }
  }
  async close() {
    this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    for (const root of this.guestRoots) await rm(root, { recursive: true, force: true });
  }
}

async function fixture(t: TestContext, patch: Partial<ManagerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-relay-manager-')));
  const registryPath = join(root, 'AGENTS.md'); await writeFile(registryPath, registryText);
  const service = new FixtureService(root), vm = await service.start();
  const options: ManagerOptions = { project: root, sessionId: randomUUID(), stateRoot: join(root, 'state'), outputRoot: join(root, 'packages'), registry: new Registry(registryPath), vm, runtimeBundle: bundle, heartbeatMs: 60000, verifyDestroyed: async name => !service.leases.has(name), captureReadyWaitMs: 1000, captureReadyRetryMs: 50, ...patch };
  const manager = new RelayManager(options);
  t.after(async () => { service.releaseFailures = 0; service.failHeartbeat = false; service.failGet = false; service.hideLeases = false; await manager.release(); await manager.cleanup('test teardown'); await service.close(); await rm(root, { recursive: true, force: true }); });
  const driver = join(root, 'fake-cua');
  await writeFile(driver, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version'){console.log('fixture-cua 1.0');process.exit(0);}if(process.argv[2]!=='call'||process.argv[3]!=='get_desktop_state'||process.argv[4]!=='--json')process.exit(99);const down=()=>{console.error('Cua Driver daemon is not running');process.exit(1);};if(fs.existsSync(${JSON.stringify(join(root, 'capture-fails'))}))down();const n=${JSON.stringify(join(root, 'capture-fails-count'))};if(fs.existsSync(n)){const left=Number(fs.readFileSync(n,'utf8'));if(left>0){fs.writeFileSync(n,String(left-1));down();}}const a=JSON.parse(process.argv[5]);fs.appendFileSync(a.screenshot_out_file.includes('.stage-capture-probe')?${JSON.stringify(join(root, 'probes.jsonl'))}:${JSON.stringify(join(root, 'captures.jsonl'))},JSON.stringify(a)+'\\n');fs.writeFileSync(a.screenshot_out_file,Buffer.from('${png}','base64'));console.log(JSON.stringify({screenshot_file_path:a.screenshot_out_file}));`);
  await chmod(driver, 0o700);
  const stage = () => manager.stage({ cuaDriver: driver, nodePath: process.execPath });
  const assertClean = async () => {
    assert.deepEqual(manager.guestStatus(), { active: false }); assert.deepEqual(manager.status().guests, []); assert.equal(service.leases.size, 0);
    assert.equal(await readFile(registryPath, 'utf8'), registryText);
    for (const guest of await readdir(join(manager.root, 'guests')).catch(() => [] as string[])) assert.equal(await json(leaseFile(manager, guest)), null, `guest ${guest} keeps no record`);
  };
  const assertRetained = async (vm: string | undefined = manager.guestStatus().vm) => {
    assert.equal(manager.guestStatus().vm, vm); assert.ok(vm); assert.equal(service.leases.has(vm), true);
    assert.equal(service.releaseCalls, 0);
    assert.equal((await json(leaseFile(manager))).lease.vm, vm);
    assert.notEqual(await readFile(registryPath, 'utf8'), registryText);
  };
  return { root, manager, service, options, driver, stage, assertClean, assertRetained, registryPath };
}

test('real HTTP service, receiver and Registry: acquire → stage → exec/script/code → extraction → verified finish', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'input')); await writeFile(join(f.root, 'input', 'seed.txt'), 'workspace seed');
  await writeFile(join(f.root, 'support.txt'), 'support bytes');
  await writeFile(join(f.root, 'script.js'), "require('node:fs').writeFileSync('artifact.txt', 'script artifact');console.log('script result')");
  const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'artifact', path: 'artifact.txt' }], fullWorkspace: true, ttlHours: 0.5 }));
  const hostRoot = f.manager.guestStatus().output!;
  assert.match(await readFile(f.registryPath, 'utf8'), /vm-service relay-manager-test-/);
  const lease = await json(leaseFile(f.manager));
  assert.equal(Object.hasOwn(lease, 'because'), false);
  assert.equal(lease.lease.vm, acquired.vm); assert.equal(lease.row.machine, `127.0.0.1 (vm-service ${lease.purpose})`);
  await f.manager.stage({ workspace: 'input', files: [{ local: 'support.txt', path: 'nested/support.txt' }], cuaDriver: f.driver, nodePath: process.execPath });
  assert.equal(await readFile(join(acquired.guestRoot, 'support/nested/support.txt'), 'utf8'), 'support bytes');
  assert.equal(await readFile(join(acquired.workspace, 'seed.txt'), 'utf8'), 'workspace seed');
  for (const run of [operation('exec'), operation('script', { inline: false, code: undefined, language: 'javascript', localPath: 'script.js' }), operation('code', { inline: true, language: 'javascript', code: "console.log(require('node:fs').readFileSync('artifact.txt','utf8'))" })]) {
    const result = await f.manager.run(run);
    assert.equal(result.outcome.kind, 'completed', JSON.stringify(result));
  }
  const extracted = await f.manager.extract(['artifact']);
  assert.equal(extracted[0].facts.length, 1); assert.equal(await readFile(extracted[0].destination, 'utf8'), 'script artifact');
  await writeFile(join(acquired.workspace, 'artifact.txt'), 'artifact version two');
  const delivered = await f.manager.finish();
  assert.equal(await readFile(extracted[0].destination, 'utf8'), 'script artifact', 'finish must not overwrite earlier extraction');
  const versions = await readdir(join(hostRoot, 'extractions/artifact'));
  assert.equal(versions.length, 2);
  assert.deepEqual((await Promise.all(versions.map(v => readFile(join(hostRoot, 'extractions/artifact', v), 'utf8')))).sort(), ['artifact version two', 'script artifact']);
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.snapshots, 'complete'); assert.equal(delivered.execution, 'passed'); assert.equal('humanReview' in delivered, false, 'the relay performs no human review');
  assert.deepEqual(await verifyDeliveredPackage(hostRoot), delivered);
  const workspaceVersions = await readdir(join(hostRoot, 'extractions/full-workspace'));
  assert.equal(workspaceVersions.length, 1);
  assert.equal(await readFile(join(hostRoot, 'extractions/full-workspace', workspaceVersions[0], 'seed.txt'), 'utf8'), 'workspace seed');
  assert.equal((await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length, 6);
  const retained = await readdir(join(hostRoot, 'host/requests'));
  assert.equal(retained.length, 3);
  for (const path of retained) assert.equal((await json(join(hostRoot, 'host/requests', path))).because, reason);
  const lifecycle = await json(`${hostRoot}.lifecycle.json`);
  assert.equal(lifecycle.released, true); assert.deepEqual(lifecycle.delivered, delivered);
  assert.equal(lifecycle.reason, 'finished');
  const lifecycleEvents = await Promise.all((await readdir(join(hostRoot, 'host/events'))).map(path => json(join(hostRoot, 'host/events', path))));
  for (const event of lifecycleEvents) assert.equal(Object.hasOwn(event, 'because'), false);
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
  assert.ok(f.service.requests.some(r => r.path === '/acquire' && r.method === 'POST' && r.body.env === 'none' && r.body.wait === true));
});

test('single relay tool: real HTTP/receiver acquire → stage → exec/script/code → extract → verified finish', { timeout: 30000 }, async t => {
  const f = await fixture(t, { heartbeatMs: 10 });
  const ctx = {} as ExtensionContext, signal = new AbortController().signal;
  const contexts: ExtensionContext[] = [];
  const tool = createRelayTool(context => { contexts.push(context); return f.manager; });
  assert.equal(tool.name, 'relay');
  const execute = async (args: RelayInput) => {
    const result = await tool.execute(`tool-${contexts.length}`, args, signal, undefined, ctx);
    if (args.action === 'run') {
      const details = result.details as any;
      assert.equal(details.kind, 'relay-image-result-v1'); assert.equal(details.isError, false);
      assert.equal(details.imageDelivery.status, 'pending', JSON.stringify(details.imageDelivery));
      assert.equal(result.content.filter(c => c.type === 'image').length, 0, 'the run does not wait for its after-image');
      return details.result;
    }
    assert.equal(result.content.length, 1);
    const content = result.content[0]; assert.equal(content.type, 'text');
    if (content.type !== 'text') throw new Error('Expected JSON text result');
    const payload = JSON.parse(content.text);
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), payload, 'tool preserves serializable manager payload in details and JSON content');
    return payload;
  };
  const why = (action: string) => `${reason}: single-tool ${action}`;
  const declarations = [{ name: 'artifact', path: 'artifact.txt' }];
  const acquired = await execute({ action: 'acquire', task: 'manager-test', image: 'ubuntu2404', extractions: declarations, ttlHours: 0.5 });
  const hostRoot = f.manager.guestStatus().output!;
  assert.deepEqual(acquired.declarations, declarations);
  assert.equal(acquired.vm, f.manager.guestStatus().vm);
  assert.match(await readFile(f.registryPath, 'utf8'), /vm-service relay-manager-test-/);
  assert.equal(Object.hasOwn(await json(leaseFile(f.manager)), 'because'), false);
  await writeFile(join(f.root, 'tool-script.js'), "require('node:fs').appendFileSync('artifact.txt', '|script');console.log('script result')");
  const staged = await execute({ action: 'stage', guest: G, cuaDriver: f.driver, nodePath: process.execPath });
  assert.equal(staged.staged, true); assert.equal(staged.workspace, acquired.workspace);
  f.service.receiverHook = async () => { await f.service.heartbeatDuringExec.promise; };
  const runs: Extract<RelayInput, { action: 'run' }>[] = [
    { action: 'run', guest: G, reason: why('exec'), language: 'shell', inline: true, code: sh([process.execPath, '-e', "require('node:fs').writeFileSync('artifact.txt', 'exec artifact');console.log('exec result')"]), step: { ...operation('tool-exec').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
    { action: 'run', guest: G, reason: why('script'), inline: false, localPath: 'tool-script.js', language: 'javascript', step: { ...operation('tool-script').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
    { action: 'run', guest: G, reason: why('code'), inline: true, code: "require('node:fs').appendFileSync('artifact.txt', '|code');console.log('code result')", language: 'javascript', step: { ...operation('tool-code').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
  ];
  for (const run of runs) {
    const result = await execute(run);
    assert.equal(result.outcome.kind, 'completed');
    assert.equal(result.outcome.exitStatus.code, 0);
    assert.equal(result.evidencePath, hostRoot); assert.equal(result.leaseReleased, false);
    const request = await json(join(hostRoot, 'host/requests', `${result.executionId}.json`));
    assert.equal(request.because, run.reason);
    assert.equal(Object.hasOwn(request, 'action'), false, 'single-tool discriminator never leaks into the receiver contract');
    assert.equal(Object.hasOwn(request, 'reason'), false, 'receiver retains the existing because field');
    assert.deepEqual(await json(join(acquired.guestRoot, 'requests', `${result.executionId}.json`)), request);
  }
  assert.ok(f.service.heartbeatCount > 0, 'heartbeat remains live during a tool-dispatched receiver operation');
  assert.equal(f.service.receiverCalls, 3); assert.equal(f.service.maxReceiverActive, 1);
  const extracted = await execute({ action: 'extract', guest: G, names: ['artifact'] });
  assert.equal(extracted.length, 1); assert.equal(extracted[0].facts.length, 1);
  assert.equal(extracted[0].name, 'artifact'); assert.equal(extracted[0].path, 'artifact.txt');
  assert.equal(await readFile(extracted[0].destination, 'utf8'), 'exec artifact|script|code');
  const delivered = await execute({ action: 'finish', guest: G });
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.snapshots, 'complete');
  assert.equal(delivered.execution, 'passed'); assert.equal('humanReview' in delivered, false, 'the relay performs no human review');
  assert.deepEqual(await verifyDeliveredPackage(hostRoot), delivered);
  const events = await Promise.all((await readdir(join(hostRoot, 'host/events'))).map(path => json(join(hostRoot, 'host/events', path))));
  for (const kind of ['acquire-intent', 'stage', 'extract', 'finish']) {
    const event = events.find(event => event.kind === kind); assert.ok(event, `Missing durable ${kind} event`);
    assert.equal(Object.hasOwn(event, 'because'), false);
  }
  const intent = events.find(event => event.kind === 'acquire-intent').details;
  assert.equal(Object.hasOwn(intent, 'because'), false);
  assert.equal(Object.hasOwn(intent, 'action'), false); assert.equal(Object.hasOwn(intent, 'reason'), false);
  assert.equal((await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length, 6);
  const lifecycle = await json(`${hostRoot}.lifecycle.json`);
  assert.equal(lifecycle.released, true); assert.deepEqual(lifecycle.delivered, delivered);
  assert.equal(contexts.length, 7); assert.ok(contexts.every(context => context === ctx));
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
  assert.equal(guestOf(f.manager)?.timer, undefined, 'finish clears the heartbeat timer');
});

test('the shipped MCP server stages its shipped receiver and completes a full HTTP lifecycle over stdio', async t => {
  const f = await fixture(t);
  const bin = join(f.root, 'bin'); await mkdir(bin); await writeFile(join(bin, 'tart'), '#!/bin/sh\nprintf "[]"\n'); await chmod(join(bin, 'tart'), 0o700);
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: f.root, MCP_RELAY_STATE_DIR: join(f.root, 'compiled-state'), MCP_RELAY_URL: f.manager.vm.baseUrl, MCP_RELAY_REGISTRY: f.registryPath, MCP_RELAY_PROJECT: f.root, MCP_RELAY_SESSION: 'compiled-distribution-fixture', PATH: `${bin}:${process.env.PATH}` };
  delete env.VM_ENVIRONMENT_FILE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.mjs')], env });
  const client = new Client({ name: 'manager-test', version: '0' });
  await client.connect(transport);
  try {
    // Fourteen relay_* tools replace the old single relay tool; a call's
    // action selects which one (run is relay_script), and the rest of the
    // args are its own arguments (no action field on the wire).
    const toolFor = ({ action }: { action: string }) => action === 'run' ? 'relay_script' : `relay_${action.replace(/-/g, '_')}`;
    let named: { imageId: string } | undefined;
    const invoke = async (args: Record<string, unknown>) => {
      const { action, ...rest } = args as { action: string; [key: string]: unknown };
      const result: any = await client.callTool({ name: toolFor({ action }), arguments: rest });
      assert.equal(result.isError, false, result.content[0].text);
      if (action === 'run') {
        // The saved after-image is named, its identity leading the text, and downloads in the background.
        const identity = JSON.parse(result.content[0].text.split('\n')[0]);
        assert.equal(identity.imageDelivery.status, 'pending', JSON.stringify(identity));
        assert.match(identity.imageDelivery.image.imageId, /^image-[a-f0-9]{64}$/);
        named = identity.imageDelivery.image;
        assert.equal(identity.executionFailed, false);
        assert.equal(result.content.filter((c: any) => c.type === 'image').length, 0);
      }
      return relayJson(result.content[0].text);
    };
    const acquired = await invoke({ action: 'acquire', task: 'manager-test', image: 'ubuntu2404', extractions: [{ name: 'artifact', path: 'artifact.txt' }] });
    await invoke({ action: 'stage', guest: G, nodePath: process.execPath, cuaDriver: f.driver });
    const result = await invoke({ action: 'run', guest: G, reason, language: 'shell', inline: true, code: sh([process.execPath, '-e', "require('fs').writeFileSync('artifact.txt','compiled package')"]), step: { id: 'compiled', title: 'Compiled package', expected: 'Declared artifact written', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } });
    assert.equal(result.outcome.kind, 'completed');
    const image: any = await client.callTool({ name: 'relay_image', arguments: { guest: G, target: { source: 'reference', imageId: named!.imageId } } });
    assert.equal(image.isError, false, image.content[0].text);
    assert.equal(image.content.find((c: any) => c.type === 'image').mimeType, 'image/png', 'relay_image shows the downloaded after-image');
    const status: any = await client.callTool({ name: 'relay_status', arguments: {} });
    const owned = JSON.parse(status.content[0].text);
    assert.equal(owned.active, true); assert.equal(owned.service, f.manager.vm.baseUrl); assert.equal(owned.maxGuests, 4);
    assert.deepEqual(owned.guests.map((guest: any) => [guest.guest, guest.staged, guest.active]), [[G, true, true]], 'relay_status lists the guest by name');
    const delivered = await invoke({ action: 'finish', guest: G }); assert.equal(delivered.execution, 'passed'); assert.equal(delivered.deliveryVerified, true);
    assert.deepEqual(await verifyDeliveredPackage(acquired.output), delivered);
    assert.equal(f.service.receiverCalls, 1); assert.equal(f.service.leases.size, 0);
    assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
  } finally {
    await client.close();
  }
});

test('production tool boundary: saved source images, bounded recovery and one consumer export', { timeout: 30000 }, async t => {
  const f = await fixture(t), tool = createRelayTool(() => f.manager);
  const invoke = (args: RelayInput) => tool.execute('image-boundary', args, undefined, undefined, {} as ExtensionContext);
  const imageDetails = (response: Awaited<ReturnType<typeof invoke>>, status: string) => {
    const details = response.details as any;
    assert.equal(details.kind, 'relay-image-result-v1');
    assert.equal(details.imageDelivery.status, status, JSON.stringify(details.imageDelivery));
    assert.equal(response.content.filter(c => c.type === 'image').length, status === 'attached' ? 1 : 0);
    return details;
  };
  const acquired = (await invoke({ action: 'acquire', task: 'manager-test', image: 'ubuntu2404', extractions: [{ name: 'consumer', path: 'consumer' }] })).details as any;
  await invoke({ action: 'stage', guest: G, cuaDriver: f.driver, nodePath: process.execPath });
  const run = (id: string, code = 'console.log("fixture input")', snapshots: RunInput['snapshots'] = { afterIntervalMs: 0 }) => invoke({
    action: 'run', guest: G, reason, language: 'shell', inline: true, code: sh([process.execPath, '-e', code]), step: operation(id).step, snapshots,
  } as RelayInput);
  const first = imageDetails(await run('source', `const fs=require('fs');fs.mkdirSync('consumer');fs.writeFileSync('consumer/screenshot.png',Buffer.from('${png}','base64'));fs.writeFileSync('consumer/result.txt','consumer output');`), 'pending');
  assert.equal(first.isError, false); assert.equal(first.result.outcome.kind, 'completed');
  const descriptor = first.imageDelivery.image;
  assert.equal(descriptor.source, 'display'); assert.equal(descriptor.phase, 'after');
  assert.equal(descriptor.executionId, first.result.executionId);
  // relay_image by display selector waits for the background download, then shows the image the run named.
  const shownFirst = imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'display', sessionId: descriptor.sessionId, executionId: descriptor.executionId, phase: 'after' } }), 'attached');
  assert.deepEqual(shownFirst.imageDelivery.image, descriptor);
  assert.deepEqual(await readFile(descriptor.originalPath), Buffer.from(png, 'base64'));
  const counters = async () => ({ receiver: f.service.receiverCalls,
    captures: (await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length,
    acquire: f.service.requests.filter(r => r.path === '/acquire').length,
    exports: await readdir(join(acquired.output, 'extractions')).catch(() => []),
    requests: f.service.requests.length,
  });
  const before = await counters();
  const again = imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'reference', imageId: descriptor.imageId } }), 'attached');
  assert.deepEqual(again.imageDelivery.image, descriptor);
  assert.deepEqual(await counters(), before, 'local reference recovery must not perform guest input, capture, acquisition, transfer or export');
  const application = imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'application', name: 'consumer', path: 'screenshot.png' } }), 'attached');
  assert.equal(application.imageDelivery.image.source, 'application');
  assert.equal(application.imageDelivery.image.name, 'consumer');
  assert.deepEqual(await readFile(application.imageDelivery.image.originalPath), Buffer.from(png, 'base64'));
  assert.equal(f.service.receiverCalls, before.receiver);
  assert.equal((await counters()).captures, before.captures);
  assert.deepEqual((await counters()).exports, []);
  imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'display', sessionId: 'foreign-session', executionId: descriptor.executionId, phase: 'after' } }), 'unauthorized-reference');
  imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'reference', imageId: `image-${'0'.repeat(64)}` } }), 'unauthorized-reference');
  imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'application', name: 'consumer', path: '../escape.png' } }), 'unsafe-path');
  for (const phase of ['first', 'member', 'last'] as const) {
    const grouped = imageDetails(await run(`group-${phase}`, undefined, { group: { groupId: 'text-group', phase }, ...(phase === 'last' ? { afterIntervalMs: 0 } : {}) }), phase === 'last' ? 'pending' : 'not-requested');
    assert.equal(grouped.result.outcome.kind, 'completed');
    if (phase === 'last') { assert.equal(grouped.imageDelivery.image.groupId, 'text-group'); imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'reference', imageId: grouped.imageDelivery.image.imageId } }), 'attached'); }
  }
  // The step download fails its three archive pulls; it is not queued again, and relay_image then makes its own copy.
  f.service.archivePullFailures = 3;
  const pullsBefore = f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('.png')).length;
  const failedTransfer = imageDetails(await run('transfer-failure'), 'pending');
  assert.equal(failedTransfer.result.outcome.kind, 'completed');
  const recoveryBefore = await counters();
  const recovered = imageDetails(await invoke({ action: 'image', guest: G, target: { source: 'reference', imageId: failedTransfer.imageDelivery.image.imageId } }), 'attached');
  assert.ok(f.service.archivePullFailures <= 0);
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('.png')).length - pullsBefore, 1, 'the retrieval\'s own copy');
  const record = await json(join(acquired.output, 'host/evidence-downloads', `${failedTransfer.result.executionId}.json`));
  assert.equal(record.status, 'failed'); assert.equal(record.failure, 'transfer-failed'); assert.equal(record.image.imageId, failedTransfer.imageDelivery.image.imageId);
  assert.deepEqual(recovered.imageDelivery.image, failedTransfer.imageDelivery.image);
  assert.equal((await counters()).receiver, recoveryBefore.receiver); assert.equal((await counters()).captures, recoveryBefore.captures);
  assert.equal((await counters()).acquire, recoveryBefore.acquire); assert.deepEqual((await counters()).exports, []);
  const failedExecution = imageDetails(await run('failed-execution', 'process.exit(9)'), 'pending');
  assert.equal(failedExecution.isError, true); assert.equal(failedExecution.result.outcome.exitStatus.code, 9);
  const delivered = (await invoke({ action: 'finish', guest: G })).details as any;
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.execution, 'failed');
  assert.deepEqual(await verifyDeliveredPackage(acquired.output), delivered);
  assert.deepEqual(await readdir(join(acquired.output, 'extractions')), ['consumer']);
  const exports = await readdir(join(acquired.output, 'extractions/consumer')); assert.equal(exports.length, 1);
  const exported = join(acquired.output, 'extractions/consumer', exports[0]);
  assert.equal(await readFile(join(exported, 'result.txt'), 'utf8'), 'consumer output');
  assert.deepEqual(await readFile(join(exported, 'screenshot.png')), Buffer.from(png, 'base64'));
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
});

test('single relay tool: acquire → release records structured lifecycle and cleans durable ownership', async t => {
  const f = await fixture(t), tool = createRelayTool(() => f.manager);
  const ctx = {} as ExtensionContext, signal = new AbortController().signal;
  await tool.execute('acquire-release', { action: 'acquire', task: 'manager-test', image: 'ubuntu2404', extractions: [] }, signal, undefined, ctx);
  const hostRoot = f.manager.guestStatus().output!;
  const result = await tool.execute('release', { action: 'release', guest: G }, signal, undefined, ctx);
  assert.deepEqual(result.details, { guest: G, active: false, released: true });
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ guest: G, active: false, released: true }, null, 2) }]);
  const events = await Promise.all((await readdir(join(hostRoot, 'host/events'))).map(path => json(join(hostRoot, 'host/events', path))));
  assert.equal(Object.hasOwn(events.find(event => event.kind === 'release'), 'because'), false);
  assert.equal(f.service.requests.find(request => request.path.endsWith('/release'))?.body.reason, 'released');
  assert.equal((await json(`${hostRoot}.lifecycle.json`)).released, true);
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
  assert.equal(guestOf(f.manager)?.timer, undefined, 'release clears the heartbeat timer');
});

test('single relay tool: unknown actions and cross-action fields reject before getter or HTTP dispatch', async t => {
  const f = await fixture(t); let getterCalls = 0;
  const tool = createRelayTool(() => { getterCalls++; return f.manager; });
  const invalid = [
    { action: 'unknown', reason },
    { action: 'relay_acquire', reason, task: 'manager-test', image: 'ubuntu2404', extractions: [] },
    { action: 'acquire', reason, task: 'manager-test', image: 'ubuntu2404', extractions: [], names: ['artifact'] },
    { action: 'stage', guest: G, reason, argv: [process.execPath, '-e', 'process.exit(0)'] },
    { action: 'run', guest: G, reason, kind: 'exec', language: 'shell', inline: true, code: 'exit 0', step: operation('invalid').step, snapshots: { afterIntervalMs: 0 } },
    { action: 'run', guest: G, reason, argv: [process.execPath, '-e', 'process.exit(0)'], step: operation('invalid').step, snapshots: { afterIntervalMs: 0 } },
    { action: 'extract', guest: G, reason, names: [], image: 'ubuntu2404' },
    { action: 'finish', guest: G, reason, names: [] },
    { action: 'release', guest: G, reason, task: 'manager-test' },
    { action: 'acquire', because: reason, task: 'manager-test', image: 'ubuntu2404', extractions: [] },
  ];
  for (const args of invalid) {
    await assert.rejects(tool.execute('invalid', args as never, undefined, undefined, {} as ExtensionContext), /Invalid relay input/);
    assert.equal(getterCalls, 0, 'invalid input must not even obtain a manager');
    assert.deepEqual(f.service.requests, [], 'invalid input must not reach the fixture service');
  }
  assert.deepEqual(f.manager.guestStatus(), { active: false });
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});

test('cancel after acquire dispatch retains returned identity until explicit release; pre-abort never allocates', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.service.acquireHook = async () => { controller.abort(new Error('cancel during allocation')); };
  await assert.rejects(f.manager.acquire(acquireInput(), controller.signal), /cancel during allocation/);
  await f.assertRetained([...f.service.leases.keys()][0]);
  assert.match(f.manager.guestStatus().lastError!, /cancel during allocation/);
  await f.stage();
  assert.equal((await f.manager.run(operation('after-cancel'))).outcome.kind, 'completed');
  await f.manager.release(); await f.assertClean();
  await assert.rejects(f.manager.acquire(acquireInput(), AbortSignal.abort(new Error('already cancelled'))), /already cancelled/);
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
});

test('stage transfer failure retains lease and corrected transfer stages the same VM', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); f.service.failPush = true;
  await assert.rejects(f.stage(), /fixture push failed/); await f.assertRetained(acquired.vm);
  assert.equal(f.manager.guestStatus().staged, false);
  f.service.failPush = false; await f.stage();
  assert.equal((await f.manager.run(operation('after-transfer-repair'))).outcome.kind, 'completed');
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

for (const [label, run, expected] of [
  ['nonzero', operation('nonzero', { code: sh([process.execPath, '-e', 'process.exit(7)']) }), 'completed'],
  ['refused', operation('orphan', { snapshots: { group: { groupId: 'not-started', phase: 'member' } } }), 'refused'],
] as const) test(`${label} receiver outcome retains the VM for a new operation without replay`, { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage(); const hostRoot = f.manager.guestStatus().output!;
  const result = await f.manager.run(run);
  assert.equal(result.outcome.kind, expected, JSON.stringify(result)); assert.equal(f.service.receiverCalls, 1); await f.assertRetained();
  assert.equal(result.leaseReleased, false); assert.match(f.manager.guestStatus().lastError!, /Execution/);
  const repaired = await f.manager.run(operation('new-operation'));
  assert.equal(repaired.outcome.kind, 'completed'); assert.notEqual(repaired.executionId, result.executionId);
  assert.equal(f.service.receiverCalls, 2);
  await f.manager.release(); await f.assertClean();
  const verified = await verifyDeliveredPackage(hostRoot); assert.equal(verified.execution, 'failed'); assert.equal('humanReview' in verified, false, 'the relay performs no human review');
});

test('heartbeat remains live during a blocked receiver operation', { timeout: 20000 }, async t => {
  const f = await fixture(t, { heartbeatMs: 10 });
  await f.manager.acquire(acquireInput()); await f.stage();
  f.service.receiverHook = async () => { await f.service.heartbeatDuringExec.promise; };
  assert.equal((await f.manager.run(operation('long-run'))).outcome.kind, 'completed');
  assert.ok(f.service.heartbeatCount > 0); await f.manager.finish(); await f.assertClean();
});

test('heartbeat uncertainty retains ownership and a later successful operation resumes work', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  f.service.failHeartbeat = true; f.service.failGet = true;
  await guestOf(f.manager)?.heartbeat(); await guestOf(f.manager)?.queue;
  await f.assertRetained(acquired.vm); assert.match(f.manager.guestStatus().lastError!, /heartbeat lost/i);
  assert.equal(f.manager.guestStatus().guestState, 'unknown', 'unavailable reconciliation cannot claim guest health');
  assert.equal(f.manager.guestStatus().expiresAt, f.service.leases.get(acquired.vm!)!.ttl_expires_at);
  f.service.failHeartbeat = false; f.service.failGet = false; await guestOf(f.manager)?.heartbeat();
  assert.equal(f.manager.guestStatus().guestState, 'running');
  await f.stage(); assert.equal((await f.manager.run(operation('after-heartbeat'))).outcome.kind, 'completed');
  await f.manager.release(); await f.assertClean();
});

test('unconfirmed release retains durable lease and registry until explicit retry succeeds', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); f.service.releaseFailures = 3;
  await assert.rejects(f.manager.release(), /destruction unavailable/);
  assert.equal(f.service.releaseCalls, 3); assert.equal(f.service.leases.size, 1); assert.equal(f.manager.guestStatus().vm, acquired.vm);
  assert.equal((await json(leaseFile(f.manager))).lease.vm, acquired.vm);
  assert.notEqual(await readFile(f.registryPath, 'utf8'), registryText);
  await f.manager.release(); await f.assertClean(); assert.equal(f.service.releaseCalls, 4);
});

for (const ending of ['settle', 'cleanup'] as const) test(`${ending} pauses renewal without destroying ownership and is idempotent`, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  assert.equal(f.manager.guestStatus().active, true);
  if (ending === 'settle') { await f.manager.settle(); await f.manager.settle(); }
  else { await f.manager.cleanup('shutdown fixture'); await f.manager.cleanup('shutdown fixture'); }
  await f.assertRetained(acquired.vm); assert.equal(f.manager.guestStatus().active, false);
  assert.equal(guestOf(f.manager)?.timer, undefined);
  assert.equal((await json(leaseFile(f.manager))).active, false);
  if (ending === 'cleanup') await assert.rejects(f.manager.acquire(acquireInput()), /shutting down/);
  else { await f.stage(); assert.equal(f.manager.guestStatus().active, true); }
  await f.manager.release(); await f.assertClean();
});

test('new manager restores durable ownership without allocation or destruction', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  await f.manager.cleanup('simulated shutdown');
  assert.equal(await readFile(join(f.manager.root, 'owner.lock'), 'utf8'), '', 'stable lock inode survives unlock');
  const recovered = new RelayManager({ ...f.options, maxGuests: 1 });
  try {
    await recovered.initialize(); assert.equal(recovered.guestStatus().vm, acquired.vm);
    assert.equal(recovered.guestStatus().active, false); assert.equal(recovered.guestStatus().guestState, 'running');
    assert.equal(recovered.guestStatus().guest, G, 'the restored guest keeps its name');
    assert.equal(f.service.releaseCalls, 0);
    await assert.rejects(recovered.acquire(acquireInput()), /the most MCP_RELAY_MAX_GUESTS allows \(1\): manager-test-1/);
    await recovered.stage({ cuaDriver: f.driver, nodePath: process.execPath });
    assert.equal((await recovered.run(operation('restored'))).outcome.kind, 'completed');
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
  } finally { await recovered.release(); await recovered.cleanup('recovery teardown'); await f.manager.initialize(); }
});

test('finish destruction failure and later recovery do not modify the sealed package', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  await f.manager.run(operation('sealed-result')); const hostRoot = f.manager.guestStatus().output!;
  f.service.releaseFailures = 3;
  await assert.rejects(f.manager.finish(), /destruction unavailable/);
  const manifest = await readFile(join(hostRoot, 'manifest.json'), 'utf8');
  const delivered = await verifyDeliveredPackage(hostRoot); assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.execution, 'passed');
  assert.equal(f.service.leases.size, 1); assert.notEqual(await readFile(f.registryPath, 'utf8'), registryText);
  const pulls = f.service.requests.filter(r => r.path.endsWith('/pull')).length;
  await assert.rejects(f.manager.run(operation('sealed-mutation')), /Evidence already sealed/);
  assert.deepEqual(await f.manager.finish(), delivered); await f.assertClean();
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/pull')).length, pulls, 'sealed finish retry does not repull or rebuild evidence');
  assert.equal(await readFile(join(hostRoot, 'manifest.json'), 'utf8'), manifest);
  assert.deepEqual(await verifyDeliveredPackage(hostRoot), delivered);
  assert.ok((await readdir(`${hostRoot}.lifecycle-events`)).length >= 2, 'post-seal failures and release intent belong outside the manifest');
});

test('restart attaches to the staged SDK session without replay and admits a new operation', { timeout: 20000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('before-interruption')); const hostRoot = f.manager.guestStatus().output!;
  const checkpoint = await json(leaseFile(f.manager));
  const receipt = await readFile(join(hostRoot, 'host/receipts', `${run.executionId}.json`), 'utf8');
  await f.manager.cleanup('prepare restart');
  const recovered = new RelayManager(f.options);
  try {
    await recovered.initialize(); assert.equal(recovered.guestStatus().vm, acquired.vm); assert.equal(recovered.guestStatus().staged, true);
    assert.equal((await json(leaseFile(recovered))).sessionId, checkpoint.sessionId);
    assert.equal(f.service.receiverCalls, 1, 'attach never replays input'); assert.equal(f.service.releaseCalls, 0);
    const next = await recovered.run(operation('after-interruption'));
    assert.equal(next.outcome.kind, 'completed'); assert.notEqual(next.executionId, run.executionId);
    assert.equal(f.service.receiverCalls, 2);
    assert.equal(await readFile(join(hostRoot, 'host/receipts', `${run.executionId}.json`), 'utf8'), receipt);
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
    assert.equal((await recovered.finish()).execution, 'passed');
  } finally { await recovered.release(); await recovered.cleanup('recovered staged teardown'); await f.manager.initialize(); }
});

for (const previousRecording of [false, true]) test(`cached reference survives offline manager reload (${previousRecording ? 'previous recording, not staged' : 'current recording'})`, { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('offline-original'));
  const descriptor = await shown(f.manager, run);
  if (previousRecording) {
    f.service.failPush = true;
    await assert.rejects(f.manager.stage({ resetRecording: true }), /fixture push failed/);
    f.service.failPush = false;
    assert.equal(f.manager.guestStatus().staged, false);
    assert.equal(f.manager.guestStatus().previousEvidence?.length, 1);
  }
  await f.manager.cleanup('offline reload fixture');
  let offline = true;
  const calls: string[] = [];
  const offlineVm = new Proxy(f.options.vm!, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (offline) { calls.push(String(property)); throw new Error(`Offline VM access forbidden: ${String(property)}`); }
      return value.apply(target, args);
    };
  } });
  const recovered = new RelayManager({ ...f.options, vm: offlineVm });
  const requestCount = f.service.requests.length, receiverCount = f.service.receiverCalls;
  const captures = await readFile(join(f.root, 'captures.jsonl'), 'utf8');
  try {
    const image = await recovered.image({ source: 'reference', imageId: descriptor.imageId });
    assert.equal(image.status, 'attached', JSON.stringify(image));
    assert.deepEqual(image.image, descriptor);
    assert.deepEqual(await readFile(image.image!.originalPath!), Buffer.from(png, 'base64'));
    assert.deepEqual(calls, [], 'even initialization must be host-only for cached image recovery');
    assert.equal(f.service.requests.length, requestCount); assert.equal(f.service.receiverCalls, receiverCount);
    assert.equal(await readFile(join(f.root, 'captures.jsonl'), 'utf8'), captures);
    assert.equal(recovered.guestStatus().staged, !previousRecording);
  } finally {
    offline = false; await recovered.release(); await recovered.cleanup('offline recovery teardown'); await f.manager.initialize();
  }
});

test('finish restores a deleted guest snapshot from the downloaded original and verifies the package', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('deleted-guest-snapshot'));
  const image = await shown(f.manager, run);
  const receipt = await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`));
  const snapshot = receipt.imageEvidence.snapshots.find((s: any) => s.phase === 'after'); assert.ok(snapshot);
  await rm(join(acquired.guestRoot, 'state/snapshots', image.sessionId!, snapshot.fileName));
  const captures = await readFile(join(f.root, 'captures.jsonl'), 'utf8');
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.snapshots, 'complete');
  assert.deepEqual(await verifyDeliveredPackage(acquired.output!), delivered);
  assert.deepEqual(await readFile(join(acquired.output!, 'state/snapshots', image.sessionId!, snapshot.fileName)), Buffer.from(png, 'base64'));
  assert.equal(await readFile(join(f.root, 'captures.jsonl'), 'utf8'), captures, 'finish must not recapture missing evidence');
  assert.equal(f.service.receiverCalls, 1); await f.assertClean();
});

test('recording reset snapshot conflict preserves retained original and each incoming attempt', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('reset-conflict'));
  const image = await shown(f.manager, run);
  const receipt = await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`));
  const snapshot = receipt.imageEvidence.snapshots.find((s: any) => s.phase === 'after'); assert.ok(snapshot);
  const relativeSnapshot = join('snapshots', image.sessionId!, snapshot.fileName);
  const retained = join(acquired.output!, 'state', relativeSnapshot);
  await mkdir(dirname(retained), { recursive: true }); await copyFile(image.originalPath!, retained);
  const guestSnapshot = join(acquired.guestRoot, 'state', relativeSnapshot);
  const captures = await readFile(join(f.root, 'captures.jsonl'), 'utf8');
  for (const changed of ['conflicting first attempt', 'conflicting second attempt']) {
    await writeFile(guestSnapshot, changed);
    await assert.rejects(f.manager.stage({ resetRecording: true }), /snapshot conflict/);
    assert.deepEqual(await readFile(retained), Buffer.from(png, 'base64'));
    assert.deepEqual(await readFile(image.originalPath!), Buffer.from(png, 'base64'));
    assert.equal(f.manager.guestStatus().output, acquired.output); assert.equal(f.manager.guestStatus().recordingResetPending, true);
    await f.assertRetained(acquired.vm);
  }
  const files = await readdir(f.options.outputRoot!, { recursive: true });
  const attempts = files.filter(path => path.endsWith(relativeSnapshot));
  const bytes = await Promise.all(attempts.map(path => readFile(join(f.options.outputRoot!, path))));
  assert.ok(bytes.some(b => b.toString() === 'conflicting first attempt'), 'first incoming state remains available');
  assert.ok(bytes.some(b => b.toString() === 'conflicting second attempt'), 'second incoming state has its own staging directory');
  assert.equal(await readFile(join(f.root, 'captures.jsonl'), 'utf8'), captures);
  assert.equal(f.service.receiverCalls, 1);
  await writeFile(guestSnapshot, Buffer.from(png, 'base64'));
  await f.manager.stage({ resetRecording: true });
  assert.equal(f.manager.guestStatus().previousEvidence?.length, 1); assert.notEqual(f.manager.guestStatus().output, acquired.output);
  const cached = await f.manager.image({ source: 'reference', imageId: image.imageId });
  assert.equal(cached.status, 'attached', JSON.stringify(cached));
  assert.deepEqual(await readFile(retained), Buffer.from(png, 'base64'));
});

test('a simultaneous manager cannot steal live session owner lock', async t => {
  const f = await fixture(t); await f.manager.initialize(); const sibling = new RelayManager(f.options);
  await assert.rejects(sibling.initialize(), /Another relay manager owns/);
  await sibling.cleanup('unowned sibling cleanup');
  await assert.rejects(sibling.initialize(), /Another relay manager owns/, 'unowned cleanup did not delete the live owner lock');
});

test('sibling stage/run/finish calls serialize through one receiver without duplicate allocation', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput());
  const results = await Promise.all([f.stage(), f.manager.run(operation('first')), f.manager.run(operation('second')), f.manager.finish()]);
  assert.equal((results[1] as any).outcome.kind, 'completed'); assert.equal((results[2] as any).outcome.kind, 'completed');
  assert.equal(f.service.maxReceiverActive, 1); assert.equal(f.service.receiverCalls, 2); await f.assertClean();
});

test('unknown/unavailable images and unsafe extraction declarations do not allocate; a sibling acquire beyond the guest limit is refused (DC-20)', async t => {
  const f = await fixture(t, { maxGuests: 1 });
  for (const image of ['unknown', 'missing']) await assert.rejects(f.manager.acquire(acquireInput({ image })), /Image unavailable/);
  for (const extractions of [[{ name: 'escape', path: '../escape' }], [{ name: 'bad/name', path: 'safe' }], [{ name: 'full-workspace', path: 'safe' }], [{ name: 'same', path: 'a' }, { name: 'same', path: 'b' }]]) await assert.rejects(f.manager.acquire(acquireInput({ extractions })));
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 0);
  assert.deepEqual(f.manager.status().guests, [], 'a refused acquisition leaves no guest');
  const results = await Promise.allSettled([f.manager.acquire(acquireInput()), f.manager.acquire(acquireInput())]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(f.service.leases.size, 1);
  assert.equal((results[0] as PromiseFulfilledResult<any>).value.guest, G, 'a refused image never used up a name');
  assert.match(String((results[1] as PromiseRejectedResult).reason), /already holds 1 guest, the most MCP_RELAY_MAX_GUESTS allows \(1\): manager-test-1/);
  await f.manager.release(); await f.assertClean();
});

test('undeclared extraction fails closed and never issues a pull for that name', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  await assert.rejects(f.manager.extract(['undeclared']), /Undeclared extraction/); await f.assertRetained();
  assert.deepEqual(await f.manager.extract([]), []);
  await f.manager.release(); await f.assertClean();
  assert.equal(f.service.requests.some(r => r.path.endsWith('/pull') && r.body.remote_path.includes('undeclared')), false);
});

test('staging traversal is rejected and corrected support path stages the retained VM', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'support.txt'), 'safe'); await f.manager.acquire(acquireInput());
  await assert.rejects(f.manager.stage({ cuaDriver: f.driver, files: [{ local: 'support.txt', path: '../escape' }] }), /Invalid relative path|Path must be inside/);
  await f.assertRetained();
  await f.manager.stage({ cuaDriver: f.driver, files: [{ local: 'support.txt', path: 'safe.txt' }] });
  await f.manager.release(); await f.assertClean();
});

/**
 * DC-15: relay_stage's files[].local and workspace, and relay_script's
 * localPath, lie in the project folder, relative or absolute. A path outside
 * it, one that climbs out with `../`, or one through a symlink is refused
 * before anything reaches the guest.
 */
async function hostPathLayout(root: string, t: TestContext) {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'relay-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'outside bytes'); await mkdir(join(outside, 'tree')); await writeFile(join(outside, 'tree', 'secret.txt'), 'outside tree');
  await writeFile(join(outside, 'script.js'), "console.log('outside script')");
  await writeFile(join(root, 'support.txt'), 'support bytes'); await writeFile(join(root, 'absolute.txt'), 'absolute bytes');
  await mkdir(join(root, 'input')); await writeFile(join(root, 'input', 'seed.txt'), 'workspace seed');
  await writeFile(join(root, 'script.js'), "console.log('relative script')"); await writeFile(join(root, 'absolute.js'), "console.log('absolute script')");
  await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt')); await symlink(join(outside, 'tree'), join(root, 'linked-tree'));
  await symlink(join(outside, 'script.js'), join(root, 'linked.js'));
  const parent = `../${outside.split('/').at(-1)}`;
  return { outside, parent };
}
const pushes = (f: { service: FixtureService }) => f.service.requests.filter(r => r.path.endsWith('/push')).length;

test('relay_stage reads files[].local and workspace only in the project folder (DC-15)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { outside, parent } = await hostPathLayout(f.root, t);
  const acquired = await f.manager.acquire(acquireInput());
  const refused: Array<[string, Parameters<RelayManager['stage']>[0]]> = [
    ['files[].local absolute outside', { files: [{ local: join(outside, 'secret.txt'), path: 'a.txt' }] }],
    ['files[].local ../', { files: [{ local: `${parent}/secret.txt`, path: 'a.txt' }] }],
    ['files[].local symlink', { files: [{ local: 'linked.txt', path: 'a.txt' }] }],
    ['files[].local absolute symlink', { files: [{ local: join(f.root, 'linked.txt'), path: 'a.txt' }] }],
    ['workspace absolute outside', { workspace: join(outside, 'tree') }],
    ['workspace ../', { workspace: `${parent}/tree` }],
    ['workspace symlink', { workspace: 'linked-tree' }],
    ['workspace absolute symlink', { workspace: join(f.root, 'linked-tree') }],
  ];
  for (const [name, input] of refused) {
    const before = pushes(f);
    await assert.rejects(f.manager.stage({ ...input, cuaDriver: f.driver, nodePath: process.execPath }), /must lie in the project folder/, name);
    assert.equal(pushes(f), before, `${name}: nothing was pushed`);
    assert.equal(f.manager.guestStatus().staged, false, name);
  }
  await f.assertRetained();
  // Relative and absolute paths inside the folder stage.
  await f.manager.stage({ workspace: 'input', files: [{ local: 'support.txt', path: 'relative.txt' }, { local: join(f.root, 'absolute.txt'), path: 'absolute.txt' }], cuaDriver: f.driver, nodePath: process.execPath });
  assert.equal(await readFile(join(acquired.guestRoot, 'support/relative.txt'), 'utf8'), 'support bytes');
  assert.equal(await readFile(join(acquired.guestRoot, 'support/absolute.txt'), 'utf8'), 'absolute bytes');
  assert.equal(await readFile(join(acquired.workspace, 'seed.txt'), 'utf8'), 'workspace seed');
  await f.manager.release(); await f.assertClean();
  // An absolute workspace inside the folder stages too.
  const g = await fixture(t); await mkdir(join(g.root, 'input')); await writeFile(join(g.root, 'input', 'seed.txt'), 'absolute workspace');
  const second = await g.manager.acquire(acquireInput());
  await g.manager.stage({ workspace: join(g.root, 'input'), cuaDriver: g.driver, nodePath: process.execPath });
  assert.equal(await readFile(join(second.workspace, 'seed.txt'), 'utf8'), 'absolute workspace');
  await g.manager.release(); await g.assertClean();
});

test('relay_script reads localPath only in the project folder (DC-15)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { outside, parent } = await hostPathLayout(f.root, t);
  await f.manager.acquire(acquireInput()); await f.stage();
  const script = (id: string, localPath: string) => operation(id, { inline: false, code: undefined, language: 'javascript', localPath });
  const relative = await f.manager.run(script('relative', 'script.js'));
  assert.deepEqual(relative.outcome, { kind: 'completed', exitStatus: { code: 0, signal: null } });
  assert.match(relative.stdout, /relative script/);
  const absolute = await f.manager.run(script('absolute', join(f.root, 'absolute.js')));
  assert.match(absolute.stdout, /absolute script/);
  for (const [name, localPath] of [['absolute outside', join(outside, 'script.js')], ['../', `${parent}/script.js`], ['symlink', 'linked.js'], ['absolute symlink', join(f.root, 'linked.js')]]) {
    const calls = f.service.receiverCalls, before = pushes(f);
    await assert.rejects(f.manager.run(script(`refused-${name.replace(/[^a-z]+/g, '-')}`, localPath)), /localPath .* must lie in the project folder/, name);
    assert.equal(f.service.receiverCalls, calls, `${name}: nothing ran in the guest`);
    assert.equal(pushes(f), before, `${name}: nothing was pushed`);
  }
  await f.assertRetained();
  await f.manager.release(); await f.assertClean();
});

test('relay_acquire asks vm-service for the network MCP_RELAY_GUEST_NETWORK names, nat by default (DC-17)', async t => {
  const previous = process.env.MCP_RELAY_GUEST_NETWORK;
  t.after(() => { if (previous === undefined) delete process.env.MCP_RELAY_GUEST_NETWORK; else process.env.MCP_RELAY_GUEST_NETWORK = previous; });
  const acquisitions = (f: { service: FixtureService }) => f.service.requests.filter(r => r.path === '/acquire').map(r => r.body);
  delete process.env.MCP_RELAY_GUEST_NETWORK;
  const nat = await fixture(t);
  assert.equal((await nat.manager.acquire(acquireInput())).network, 'nat');
  assert.deepEqual(acquisitions(nat).map(body => body.network), ['nat']);
  await nat.manager.release(); await nat.assertClean();
  process.env.MCP_RELAY_GUEST_NETWORK = 'internet';
  const internet = await fixture(t);
  assert.equal((await internet.manager.acquire(acquireInput())).network, 'internet');
  assert.deepEqual(acquisitions(internet).map(body => body.network), ['internet']);
  await internet.manager.release(); await internet.assertClean();
  // The option a host application sets wins over the environment.
  const option = await fixture(t, { guestNetwork: 'nat' });
  await option.manager.acquire(acquireInput());
  assert.deepEqual(acquisitions(option).map(body => body.network), ['nat']);
  await option.manager.release(); await option.assertClean();
});

test('a guest network other than nat or internet is refused before vm-service is asked (DC-17)', async t => {
  const previous = process.env.MCP_RELAY_GUEST_NETWORK;
  t.after(() => { if (previous === undefined) delete process.env.MCP_RELAY_GUEST_NETWORK; else process.env.MCP_RELAY_GUEST_NETWORK = previous; });
  for (const value of ['host', 'NAT', '', 'internet ']) {
    process.env.MCP_RELAY_GUEST_NETWORK = value;
    const f = await fixture(t);
    await assert.rejects(f.manager.acquire(acquireInput()), /MCP_RELAY_GUEST_NETWORK must be nat or internet/, JSON.stringify(value));
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 0);
    assert.deepEqual(f.manager.guestStatus(), { active: false }); assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
  }
  delete process.env.MCP_RELAY_GUEST_NETWORK;
  const f = await fixture(t, { guestNetwork: 'bridged' as never });
  await assert.rejects(f.manager.acquire(acquireInput()), /guestNetwork must be nat or internet/);
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 0);
});

test('vm-service refusing internet passes through, and the relay never falls back to nat (DC-17)', async t => {
  const f = await fixture(t, { guestNetwork: 'internet' });
  f.service.acquireRefusal = { status: 400, body: { error: 'network internet unavailable: Softnet is not usable on this host' } };
  await assert.rejects(f.manager.acquire(acquireInput()), /HTTP 400: .*Softnet is not usable on this host/);
  assert.deepEqual(f.service.requests.filter(r => r.path === '/acquire').map(r => r.body.network), ['internet'], 'one acquisition, never retried on nat');
  assert.equal(f.service.leases.size, 0);
  // The refusal acquired nothing, so the guest leaves the session and its registry row goes (DC-20).
  assert.deepEqual(f.manager.status().guests, []); assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
  f.service.acquireRefusal = undefined;
  assert.equal((await f.manager.acquire(acquireInput())).guest, 'manager-test-2', 'the refused guest\'s name is not reused');
  await f.manager.release();
});

const nodeOnly = { schemaVersion: 1, images: [{ image: 'ubuntu2404', os: 'linux', architecture: 'arm64', applications: [{ id: 'dpkg:nodejs', name: 'Node.js', aliases: ['node'], version: '22.0.0' }, { id: 'dpkg:python3', name: 'Python', aliases: [], version: '3.12' }] }] };

test('an image that lists no capture software stages, runs relay_script and finishes with no snapshots and a passed outcome (DC-13)', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.service.catalog = nodeOnly;
  await f.manager.acquire(acquireInput({ extractions: [{ name: 'out', path: 'out.txt' }] }));
  const before = await f.manager.probe('guest') as any;
  assert.equal(before.snapshots.taken, null, 'decided at relay_stage');
  // No cua-driver is named or present: staging assumes Node.js only.
  const staged = await f.manager.stage({ nodePath: process.execPath }) as any;
  assert.equal(staged.snapshots.taken, false); assert.match(staged.snapshots.reason, /lists no capture software \(cua-driver\)/);
  const probe = await f.manager.probe('guest') as any;
  assert.deepEqual(probe.checks.map((check: any) => [check.name, check.language, check.required, check.ready]), [['node', 'javascript', true, true], ['tsx', 'typescript', false, true], ['python3', 'python', false, true], ['sh', 'shell', false, true]], 'the runtimes are facts; only Node.js is required, and TypeScript runs with Node.js type stripping (DC-25)');
  assert.deepEqual(probe.software, { image: 'ubuntu2404', applications: nodeOnly.images[0]!.applications }, 'the listed software is the catalog\'s');
  assert.equal(probe.snapshots.taken, false);
  const run = await f.manager.run(operation('code', { inline: true, language: 'javascript', code: "require('node:fs').writeFileSync('out.txt','no capture');console.log('ran')" }));
  assert.deepEqual(run.outcome, { kind: 'completed', exitStatus: { code: 0, signal: null } });
  assert.match(run.stdout, /ran/);
  assert.equal(run.imageDelivery.status, 'not-requested'); assert.match(run.imageDelivery.diagnostic!, /no capture software/);
  const image = await f.manager.image({ source: 'display', sessionId: guestOf(f.manager)?.current().sessionId, executionId: run.executionId!, phase: 'after' });
  assert.equal(image.status, 'not-requested');
  assert.equal(await exists(join(f.root, 'captures.jsonl')), false, 'nothing was captured');
  const output = f.manager.guestStatus().output!;
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true, JSON.stringify(delivered));
  assert.equal(delivered.execution, 'passed', JSON.stringify(delivered));
  assert.equal(delivered.snapshots, 'complete', JSON.stringify(delivered));
  const verified = await verifyDeliveredPackage(output);
  assert.equal(verified.execution, 'passed'); assert.equal(verified.snapshots, 'complete');
  assert.deepEqual(verified.findings, []);
  assert.equal(await exists(join(output, 'state', 'snapshots')) ? (await readdir(join(output, 'state', 'snapshots'), { recursive: true })).some(name => String(name).endsWith('.png')) : false, false, 'the package holds no snapshots');
  const receipt = await json(join(output, 'host', 'receipts', `${run.executionId}.json`));
  assert.equal(receipt.outcome.kind, 'completed');
  const request = await json(join(output, 'host', 'requests', `${run.executionId}.json`));
  assert.equal(request.capture, false, 'the host told the receiver');
  await f.assertClean();
});

test('an image that lists cua-driver keeps its snapshots (DC-13)', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.manager.acquire(acquireInput());
  const staged = await f.stage() as any;
  assert.equal(staged.snapshots.taken, true);
  const run = await f.manager.run(operation('code', { inline: true, language: 'javascript', code: "console.log('ran')" }));
  assert.deepEqual(run.outcome, { kind: 'completed', exitStatus: { code: 0, signal: null } });
  await shown(f.manager, run);
  const captures = (await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(captures.length, 2, 'before and after');
  const output = f.manager.guestStatus().output!;
  const request = await json(join(output, 'host', 'requests', `${run.executionId}.json`));
  assert.equal(Object.hasOwn(request, 'capture'), false, 'the request is as before');
  const delivered = await f.manager.finish();
  assert.equal(delivered.execution, 'passed'); assert.equal(delivered.snapshots, 'complete');
  await f.assertClean();
});

test('on an image that lists cua-driver, a run whose snapshot cannot be taken is still not a success (DC-13)', { timeout: 30000 }, async t => {
  // The image lists cua-driver, but the driver cannot capture: as before, the run is refused before any input.
  const f = await fixture(t);
  await f.manager.acquire(acquireInput());
  await f.stage();
  await writeFile(join(f.root, 'capture-fails'), '');
  const run = await f.manager.run(operation('uncaptured-but-owed'));
  assert.equal(run.outcome.kind, 'refused', JSON.stringify(run.outcome));
  await f.manager.release(); await f.assertClean();
});

test('relay_stage refuses an image without Node.js and says so; nothing is pushed (DC-13)', async t => {
  const f = await fixture(t); f.service.noNode = true;
  await f.manager.acquire(acquireInput());
  await assert.rejects(f.manager.stage({}), /relay_stage needs Node\.js in the guest .*an image without Node\.js cannot be staged/s);
  assert.equal(pushes(f), 0); assert.equal(f.manager.guestStatus().staged, false);
  await f.assertRetained();
  await f.manager.release(); await f.assertClean();
});

test('relay_stage refuses when the image catalog cannot be read, so no run loses its snapshots by mistake (DC-13)', async t => {
  const f = await fixture(t); f.service.catalogFails = true;
  await f.manager.acquire(acquireInput());
  await assert.rejects(f.stage(), /could not read the image catalog .*capture software \(cua-driver\)/s);
  assert.equal(pushes(f), 0);
  f.service.catalogFails = false;
  const staged = await f.stage() as any;
  assert.equal(staged.snapshots.taken, true);
  await f.manager.release(); await f.assertClean();
});

test('lost acquire response reconciles by pre-recorded purpose without allocating twice', async t => {
  const f = await fixture(t); f.service.loseAcquireResponse = true;
  f.service.acquireHook = async () => {
    const intent = await json(leaseFile(f.manager));
    assert.equal(intent.acquisitionInFlight, true);
    assert.ok((await readFile(f.registryPath, 'utf8')).includes(intent.purpose));
  };
  await assert.rejects(f.manager.acquire(acquireInput()), /Acquisition outcome unknown/);
  assert.equal(f.service.leases.size, 1); assert.equal(f.service.releaseCalls, 0);
  f.service.acquireHook = undefined;
  await f.stage(); await f.assertRetained([...f.service.leases.keys()][0]);
  await f.manager.release(); await f.assertClean();
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
});

test('indeterminate invisible acquire stays durably registered until later reconciliation', async t => {
  const f = await fixture(t); f.service.loseAcquireResponse = true; f.service.hideLeases = true;
  await assert.rejects(f.manager.acquire(acquireInput()), /Acquisition outcome unknown/);
  const retained = await json(leaseFile(f.manager));
  assert.equal(retained.acquisitionInFlight, true); assert.equal(retained.lease, undefined);
  assert.equal(f.service.leases.size, 1); assert.equal(f.service.releaseCalls, 0);
  assert.ok((await readFile(f.registryPath, 'utf8')).includes(retained.purpose));
  assert.deepEqual(f.manager.status().guests.map(guest => guest.guest), [G], 'the indeterminate acquisition keeps its guest');
  f.service.hideLeases = false;
  await f.manager.release(); await f.assertClean();
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
});

test('uncertain receiver identity retains original receipt and VM without replay', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const hostRoot = f.manager.guestStatus().output!; f.service.malformedReceiverResponse = true;
  const result = await f.manager.run(operation('identity-mismatch'));
  assert.equal(result.outcome.kind, 'uncertain');
  assert.match(JSON.stringify(result), /identity mismatch/); await f.assertRetained();
  assert.equal(f.service.receiverCalls, 1);
  f.service.malformedReceiverResponse = false;
  assert.equal((await f.manager.run(operation('after-uncertain'))).outcome.kind, 'completed');
  assert.equal(f.service.receiverCalls, 2);
  await f.manager.release(); await f.assertClean();
  const verified = await verifyDeliveredPackage(hostRoot); assert.equal(verified.execution, 'uncertain');
  assert.deepEqual(await json(join(hostRoot, 'host/receipts', `${result.executionId}.json`)), { executionId: result.executionId, outcome: result.outcome });
  assert.equal(result.evidencePath, hostRoot); assert.equal(result.leaseReleased, false);
});

test('abort during a dispatched operation retains its receipt and VM without replay', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const controller = new AbortController();
  f.service.receiverHook = async () => { controller.abort(new Error('cancel dispatched run')); };
  await assert.rejects(f.manager.run(operation('cancel-run'), controller.signal), /cancel dispatched run/);
  assert.equal(f.service.receiverCalls, 1); await f.assertRetained();
  f.service.receiverHook = undefined;
  // Cancellation stops the wait, not the guest command (R6): let the cancelled receiver finish before the next run.
  while (f.service.receiverActive) await new Promise(done => setTimeout(done, 20));
  const afterAbort = await f.manager.run(operation('after-abort')); assert.equal(afterAbort.outcome.kind, 'completed', JSON.stringify(afterAbort.outcome));
  assert.equal(f.service.receiverCalls, 2); await f.manager.release(); await f.assertClean();
});

test('invalid run annotation rejects before guarded admission without releasing ownership', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput());
  const before = f.manager.guestStatus();
  const requests = f.service.requests.length;
  for (const because of ['', '  ', 'x'.repeat(4001), 42]) {
    await assert.rejects(f.manager.run(operation('invalid-reason', { because: because as string })), /reason must be nonblank/);
    assert.deepEqual(f.manager.guestStatus(), before);
    assert.equal(f.service.requests.length, requests);
  }
  assert.equal(f.service.receiverCalls, 0); assert.equal(f.service.releaseCalls, 0);
  await f.manager.release(); await f.assertClean();
});

test('a run without reason, step or interval derives its record and uses the default wait', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const result = await f.manager.run({ language: 'shell', inline: true, code: sh([process.execPath, '-e', 'console.log("derived")']) });
  assert.equal(result.outcome.kind, 'completed');
  const request = await json(join(f.manager.guestStatus().output!, 'host/requests', `${result.executionId}.json`));
  assert.equal(request.step.id, 'code-1'); assert.match(request.step.title, /^shell '[^']*node' '-e' /, 'an inline shell script is named by its first line');
  assert.equal(request.step.expected, 'Exits with status 0'); assert.equal(request.step.inputMode, 'ordinary');
  assert.deepEqual(request.snapshots, { afterIntervalMs: 500 });
  assert.match(request.because, /^Relay shell '.*\(no reason given\)$/);
  assert.equal(result.imageDelivery.status, 'pending', 'snapshots are automatic');
  // A text group's last member without its own interval gets the default too; explicit values still win.
  const group = await f.manager.run(operation('group-first', { snapshots: { group: { groupId: 'g1', phase: 'first' } } }));
  assert.equal(group.outcome.kind, 'completed');
  const last = await f.manager.run(operation('group-last', { snapshots: { group: { groupId: 'g1', phase: 'last' } } }));
  assert.equal(last.outcome.kind, 'completed');
  assert.deepEqual((await json(join(f.manager.guestStatus().output!, 'host/requests', `${last.executionId}.json`))).snapshots, { group: { groupId: 'g1', phase: 'last' }, afterIntervalMs: 500 });
  await f.manager.release(); await f.assertClean();
});

test('failure evidence logging error retains ownership until explicit release', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); const hostRoot = f.manager.guestStatus().output!;
  await rm(join(hostRoot, 'host/events'), { recursive: true }); await writeFile(join(hostRoot, 'host/events'), 'not a directory');
  f.service.failPush = true;
  await assert.rejects(f.stage(), /fixture push failed|EEXIST|ENOTDIR/); await f.assertRetained();
  await f.manager.release(); await f.assertClean();
  assert.equal(f.service.releaseCalls, 1); assert.match((await json(`${hostRoot}.delivery-error.json`)).error, /EEXIST|ENOTDIR/);
});

for (const mode of ['symlink', 'corrupt-pull'] as const) test(`${mode} extraction fails verification and allows repaired extraction on the same VM`, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput({ extractions: [{ path: 'artifact.txt', name: 'artifact' }] })); await f.stage();
  if (mode === 'symlink') { await writeFile(join(acquired.workspace, 'target.txt'), 'safe'); await symlink('target.txt', join(acquired.workspace, 'artifact.txt')); }
  else { await writeFile(join(acquired.workspace, 'artifact.txt'), 'original'); f.service.corruptPull = true; }
  await assert.rejects(f.manager.extract(['artifact']), mode === 'symlink' ? /symlink/ : /checksum mismatch/); await f.assertRetained(acquired.vm);
  if (mode === 'symlink') await rm(join(acquired.workspace, 'artifact.txt'));
  f.service.corruptPull = false; await writeFile(join(acquired.workspace, 'artifact.txt'), 'repaired');
  const extracted = await f.manager.extract(['artifact']);
  assert.equal(await readFile(extracted[0].destination, 'utf8'), 'repaired');
  await f.manager.release(); await f.assertClean();
});

test('explicit release retains declared outputs already produced before a nonzero operation', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'failure-log', path: 'error.txt' }] })); await f.stage();
  await writeFile(join(acquired.workspace, 'error.txt'), 'original failure evidence');
  const result = await f.manager.run(operation('failure', { code: sh([process.execPath, '-e', 'process.exit(1)']) }));
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
  const versions = await readdir(join(result.evidencePath, 'extractions', 'failure-log'));
  assert.equal(await readFile(join(result.evidencePath, 'extractions', 'failure-log', versions[0]), 'utf8'), 'original failure evidence');
  assert.equal((await verifyDeliveredPackage(result.evidencePath)).execution, 'failed');
});

test('late heartbeat from released enclosure cannot destroy its replacement', async t => {
  const f = await fixture(t), entered = deferred(), returnFailure = deferred();
  await f.manager.acquire(acquireInput());
  f.service.heartbeatHook = async () => { entered.resolve(); await returnFailure.promise; throw new Error('old VM gone'); };
  const heartbeat = guestOf(f.manager)?.heartbeat(); await entered.promise;
  await f.manager.release();
  const next = await f.manager.acquire(acquireInput());
  returnFailure.resolve(); await heartbeat;
  await guestOf(f.manager)?.queue;
  assert.equal(f.manager.guestStatus().vm, next.vm); assert.equal(f.service.leases.size, 1);
  await f.manager.release(); await f.assertClean();
});

test('pre-stage diagnostic records host-only results and repairs setup without allocating again', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  const tool = createRelayTool(() => f.manager);
  const args = (id: string, code: string, timeoutMs?: number): RelayInput => ({ action: 'run', guest: G, reason, language: 'shell', inline: true, diagnostic: true, code: sh([process.execPath, '-e', code]), step: { ...operation(id).step, expected: 'Diagnostic command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 }, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const failed = await tool.execute('failed-diagnostic', args('diagnose', 'process.exit(7)'), undefined, undefined, {} as ExtensionContext);
  const failure = failed.details as any;
  assert.equal(failure.kind, 'relay-image-result-v1'); assert.equal(failure.isError, true);
  assert.equal(failure.result.outcome.exitStatus.code, 7);
  assert.equal(failure.imageDelivery.status, 'not-requested');
  assert.equal(failed.content.some(c => c.type === 'image'), false);
  await f.assertRetained(acquired.vm);
  const marker = join(f.root, 'repair-marker');
  const result = await tool.execute('repair', args('repair', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'fixed');console.log('repaired')`, 3600000), undefined, undefined, {} as ExtensionContext);
  const details = result.details as any;
  assert.equal(details.kind, 'relay-image-result-v1'); assert.equal(details.isError, false);
  assert.equal(details.imageDelivery.status, 'not-requested');
  const response = details.result;
  assert.equal(response.outcome.kind, 'completed'); assert.equal(response.timeoutMs, 3600000);
  assert.equal(response.evidenceMode, 'diagnostic'); assert.equal(response.screenshotEvidence, false); assert.equal(response.leaseReleased, false);
  assert.equal(await readFile(marker, 'utf8'), 'fixed'); assert.equal(f.service.receiverCalls, 0);
  assert.equal(f.manager.guestStatus().staged, false);
  const records = await readdir(join(acquired.output!, 'host/diagnostics'));
  assert.equal(records.length, 4);
  const requests = await Promise.all(records.filter(p => p.endsWith('.request.json')).map(p => json(join(acquired.output!, 'host/diagnostics', p))));
  assert.deepEqual(requests.map(r => r.timeoutMs).sort((a, b) => a - b), [120000, 3600000]);
  assert.ok(requests.every(r => r.because === reason && r.diagnostic === true && r.argv[0] === '/bin/sh' && r.argv[1] === '-c'), 'the request records the command vm-service ran');
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/push') || r.path.endsWith('/pull')).length, 0);
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/);
  // A diagnostic script file is read on the host and runs as /bin/sh -c, before staging too (DC-26).
  const fileMarker = join(f.root, 'file-marker');
  await writeFile(join(f.root, 'repair.sh'), `printf file > ${sh([fileMarker])}\necho file-repaired\n`);
  const fromFile = (await tool.execute('repair-file', { action: 'run', guest: G, reason, language: 'shell', inline: false, localPath: 'repair.sh', diagnostic: true }, undefined, undefined, {} as ExtensionContext)).details as any;
  assert.equal(fromFile.isError, false); assert.equal(fromFile.result.output.trim(), 'file-repaired'); assert.equal(await readFile(fileMarker, 'utf8'), 'file');
  const sent = f.service.requests.filter(r => r.path.endsWith('/exec')).at(-1)!.body.argv;
  assert.deepEqual(sent.slice(0, 2), ['/bin/sh', '-c']); assert.match(sent[2], /echo file-repaired/);
  await assert.rejects(f.manager.run({ language: 'javascript', inline: true, code: '1', diagnostic: true }), /Only a shell script may be diagnostic/);
  assert.equal(f.service.receiverCalls, 0);
  await f.stage(); assert.equal((await f.manager.run(operation('after-setup-repair'))).outcome.kind, 'completed');
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

test('staged diagnostic uses the owned workspace without capture prerequisites and the next ordinary run captures', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const result = await f.manager.run(operation('staged-diagnostic', { diagnostic: true, code: sh([process.execPath, '-e', 'console.log("diagnostic output")']) }));
  assert.equal(result.outcome.kind, 'completed', JSON.stringify(result));
  assert.equal(result.evidenceMode, 'diagnostic'); assert.equal(result.output?.trim(), 'diagnostic output'); assert.equal(result.outputStreams, 'stdout and stderr combined'); assert.equal(result.stderr, undefined, 'the combined stream is not repeated as stderr');
  assert.equal(f.service.receiverCalls, 0); assert.equal(result.leaseReleased, false);
  const request = await json(join(acquired.output!, 'host/diagnostics', `${result.executionId}.request.json`));
  assert.equal(request.diagnostic, true); assert.equal(request.timeoutMs, 120000);
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/);
  const next = await f.manager.run(operation('ordinary-after-diagnostic'));
  assert.equal(next.outcome.kind, 'completed', JSON.stringify(next));
  assert.equal((await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length, 2);
  const nextRequest = await json(join(acquired.output!, 'host/requests', `${next.executionId}.json`));
  assert.notEqual(nextRequest.diagnostic, true, 'diagnostic mode cannot leak into later ordinary execution');
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

test('damaged journal can be diagnosed and explicitly archived before recording continues in the same VM', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const first = await f.manager.run(operation('before-damage')); assert.equal(first.outcome.kind, 'completed');
  const path = join(acquired.guestRoot, 'state/journal/events.jsonl');
  const original = await readFile(path); await writeFile(path, Buffer.concat([original, Buffer.from('{broken')]));
  const damaged = await f.manager.run(operation('damaged')); assert.notEqual(damaged.outcome.kind, 'completed');
  const diagnostic = await f.manager.run(operation('inspect-damage', { diagnostic: true })); assert.equal(diagnostic.outcome.kind, 'completed');
  await f.manager.stage({ resetRecording: true });
  const state = f.manager.guestStatus(); assert.ok('previousEvidence' in state && state.previousEvidence?.length === 1);
  const retained = await readFile(join(acquired.output!, 'state/journal/events.jsonl')); assert.ok(retained.toString().endsWith('{broken'));
  const recovered = await f.manager.run(operation('after-reset')); assert.equal(recovered.outcome.kind, 'completed', JSON.stringify(recovered));
  assert.notEqual(recovered.evidencePath, acquired.output); await f.assertRetained(acquired.vm);
  await f.manager.finish(); await f.assertClean();
});

test('run timeout bounds reject without dispatch and a corrected timeout reaches the receiver', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  for (const timeoutMs of [0, -1, 1.5, 3600001, NaN, Infinity]) {
    await assert.rejects(f.manager.run(operation('bad-timeout', { timeoutMs })), /timeoutMs must be an integer/);
    assert.equal(f.service.receiverCalls, 0); await f.assertRetained();
  }
  for (const timeoutMs of [undefined, 3600000]) {
    const result = await f.manager.run(operation(`valid-timeout-${timeoutMs ?? 'default'}`, { timeoutMs }));
    assert.equal(result.outcome.kind, 'completed', JSON.stringify(result)); assert.equal(result.timeoutMs, timeoutMs ?? 120000);
    const request = await json(join(result.evidencePath, 'host/requests', `${result.executionId}.json`));
    assert.equal(request.timeoutMs, timeoutMs ?? 120000);
  }
  await f.manager.release(); await f.assertClean();
});

test('guest probe reports each language runtime and the listed software read-only, before stage and after path repair (DC-23)', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  let before = f.service.requests.length;
  const initial = await f.manager.probe('guest') as any;
  assert.equal(initial.scope, 'guest'); assert.equal(initial.owned.vm, acquired.vm);
  assert.equal(initial.captureVerified, false); assert.equal(initial.browserVerified, false);
  assert.deepEqual(initial.checks.map((c: any) => [c.name, c.language, c.ready]), [['node', 'javascript', true], ['tsx', 'typescript', true], ['python3', 'python', true], ['sh', 'shell', true]]);
  assert.equal(initial.checks[1].code, 127, 'tsx itself is missing'); assert.equal(initial.checks[1].runsWith, 'Node.js type stripping', 'TypeScript runs with the guest Node.js (DC-25)');
  assert.deepEqual(initial.software.applications.map((app: any) => app.id), ['dpkg:cua-driver', 'dpkg:nodejs']);
  assert.equal('targets' in initial, false, 'relay_run targets are gone');
  let commands = f.service.requests.slice(before).filter(r => r.path.endsWith('/exec'));
  assert.deepEqual(commands.map(r => r.body.argv), [['node', '--version'], ['tsx', '--version'], ['python3', '--version'], ['/bin/sh', '-c', 'exit 0']]);
  assert.equal(f.service.receiverCalls, 0); assert.equal(f.manager.guestStatus().staged, false);
  await f.stage(); before = f.service.requests.length;
  const staged = await f.manager.probe('guest') as any;
  assert.equal(staged.captureVerified, false); assert.equal(staged.browserVerified, false);
  assert.equal(staged.snapshots.taken, true);
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/);
  commands = f.service.requests.slice(before).filter(r => r.path.endsWith('/exec'));
  assert.deepEqual(commands.map(r => r.body.argv), [[process.execPath, '--version'], ['tsx', '--version'], ['python3', '--version'], ['/bin/sh', '-c', 'exit 0']], 'the staged Node.js is the one checked');
  f.service.catalogFails = true;
  const unread = await f.manager.probe('guest') as any;
  assert.match(unread.software.diagnostic, /catalog could not be read/); assert.equal(unread.software.applications, undefined);
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

test('relay_script runs inline code and a project file in each language, shell included, in the staged workspace, with evidence (DC-23, DC-26)', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.manager.acquire(acquireInput({ extractions: [{ name: 'out', path: 'out' }] })); await f.stage();
  const programs = {
    shell: (tag: string) => `mkdir -p out && printf sh > out/sh-${tag}.txt && echo 'sh ${tag}'`,
    javascript: (tag: string) => `require('node:fs').mkdirSync('out',{recursive:true});require('node:fs').writeFileSync('out/js-${tag}.txt','js');console.log('js ${tag}')`,
    typescript: (tag: string) => `import { mkdirSync, writeFileSync } from 'node:fs';const value: string = 'ts';mkdirSync('out',{recursive:true});writeFileSync('out/ts-${tag}.txt', value);console.log('ts ${tag}')`,
    python: (tag: string) => `import os\nos.makedirs('out', exist_ok=True)\nopen('out/py-${tag}.txt', 'w').write('py')\nprint('py ${tag}')\n`,
  } as const;
  await mkdir(join(f.root, 'scripts'));
  for (const [language, program] of Object.entries(programs) as Array<[keyof typeof programs, (tag: string) => string]>) {
    const extension = { shell: 'sh', python: 'py', typescript: 'ts', javascript: 'js' }[language];
    await writeFile(join(f.root, 'scripts', `check.${extension}`), program('file'));
    for (const run of [operation(`${language}-inline`, { inline: true, language, code: program('inline') }), operation(`${language}-file`, { inline: false, code: undefined, language, localPath: `scripts/check.${extension}` })]) {
      const result = await f.manager.run(run);
      assert.deepEqual(result.outcome, { kind: 'completed', exitStatus: { code: 0, signal: null } }, `${language} ${run.inline ? 'inline' : 'file'}: ${JSON.stringify(result)}`);
      assert.match(result.stdout, new RegExp(`${{ shell: 'sh', python: 'py', typescript: 'ts', javascript: 'js' }[language]} ${run.inline ? 'inline' : 'file'}`));
      await shown(f.manager, result);
      const request = await json(join(result.evidencePath, 'host/requests', `${result.executionId}.json`));
      assert.equal('kind' in request, false, 'the request the guest receives has no kind (DC-26)');
      assert.equal(typeof (run.inline ? request.code : request.remotePath), 'string', 'inline code streams in the request; a file is pushed and named');
      assert.equal(run.inline ? request.remotePath : request.code, undefined);
      assert.equal(request.language, language);
    }
  }
  // Each run records its own before and after snapshots.
  assert.equal((await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length, 16);
  const [extracted] = await f.manager.extract(['out']);
  assert.deepEqual(extracted!.facts.map((fact: any) => fact.path.split('/').at(-1)).sort(), ['js-file.txt', 'js-inline.txt', 'py-file.txt', 'py-inline.txt', 'sh-file.txt', 'sh-inline.txt', 'ts-file.txt', 'ts-inline.txt']);
  // A call the contract refuses never reaches the manager; the manager refuses a mismatch on its own too.
  const calls = f.service.receiverCalls;
  for (const bad of [{ inline: true, localPath: 'scripts/check.js' }, { inline: false, code: '1' }, { inline: true, code: '1', localPath: 'scripts/check.js' }]) {
    await assert.rejects(f.manager.run(operation('mismatch', { language: 'javascript', code: undefined, ...bad })), /relay_script with inline/, JSON.stringify(bad));
  }
  await assert.rejects(f.manager.run(operation('diagnostic-script', { inline: true, language: 'javascript', code: '1', diagnostic: true })), /Only a shell script may be diagnostic/);
  assert.equal(f.service.receiverCalls, calls, 'nothing ran in the guest');
  const delivered = await f.manager.finish();
  assert.equal(delivered.execution, 'passed'); assert.equal(delivered.snapshots, 'complete');
  await f.assertClean();
});

test('staged executable path correction reattaches without replay or workspace replacement', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  // The driver answers at stage and then breaks, so the corrected stage reattaches to a staged guest (DC-24).
  await f.stage();
  await writeFile(join(f.root, 'capture-fails'), '');
  const failed = await f.manager.run(operation('bad-driver'));
  assert.notEqual(failed.outcome.kind, 'completed'); await f.assertRetained(acquired.vm);
  const sessionId = (await json(leaseFile(f.manager))).sessionId;
  await writeFile(join(acquired.workspace, 'keep.txt'), 'keep');
  const calls = f.service.receiverCalls;
  await rm(join(f.root, 'capture-fails'));
  await f.stage(); assert.equal(f.service.receiverCalls, calls, 'path correction cannot replay failed input');
  assert.equal((await json(leaseFile(f.manager))).sessionId, sessionId);
  assert.equal(await readFile(join(acquired.workspace, 'keep.txt'), 'utf8'), 'keep');
  const result = await f.manager.run(operation('corrected-driver'));
  assert.equal(result.outcome.kind, 'completed', JSON.stringify(result)); assert.notEqual(result.executionId, failed.executionId);
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

// A declared output that was never produced no longer fails finish (R5, docs/lifecycle-fixes.md); a transfer or checksum failure still does.
for (const failure of ['verification'] as const) test(`finish ${failure} failure retains the VM until output is repaired`, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'artifact', path: 'artifact.txt' }] }));
  await f.stage(); await f.manager.run(operation('before-finish'));
  await writeFile(join(acquired.workspace, 'artifact.txt'), 'original'); f.service.corruptPull = true;
  await assert.rejects(f.manager.finish(), /checksum mismatch/);
  await f.assertRetained(acquired.vm); assert.ok(f.manager.guestStatus().lastError);
  assert.equal((await json(leaseFile(f.manager))).delivered, undefined);
  f.service.corruptPull = false; await writeFile(join(acquired.workspace, 'artifact.txt'), 'fixed');
  const delivered = await f.manager.finish(); assert.equal(delivered.deliveryVerified, true);
  await f.assertClean(); assert.deepEqual(await verifyDeliveredPackage(acquired.output!), delivered);
});

test('fullWorkspace retry preserves the first immutable export after package transfer failure', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput({ fullWorkspace: true }));
  await f.stage(); await writeFile(join(acquired.workspace, 'seed.txt'), 'first workspace');
  // The background download fails after two copies, so the host lacks the original and the state pull fails after three.
  f.service.screenshotPullFailures = 5; f.service.archivePullFails = true;
  await f.manager.run(operation('workspace-retry'));
  await assert.rejects(f.manager.finish(), /fixture screenshot transfer unavailable/);
  const events = await Promise.all((await readdir(join(acquired.output!, 'host/events'))).map(name => json(join(acquired.output!, 'host/events', name))));
  assert.ok(events.some(event => event.kind === 'archive-fallback' && /fixture archive transfer unavailable/.test(event.details.diagnostic)), 'the fallback and its reason are logged (AD-10)');
  f.service.archivePullFails = false;
  await f.assertRetained(acquired.vm);
  const directory = join(acquired.output!, 'extractions/full-workspace');
  const firstVersions = await readdir(directory); assert.equal(firstVersions.length, 1);
  const original = join(directory, firstVersions[0], 'seed.txt');
  assert.equal(await readFile(original, 'utf8'), 'first workspace');
  assert.equal((await json(leaseFile(f.manager))).delivered, undefined);
  await writeFile(join(acquired.workspace, 'seed.txt'), 'repaired workspace');
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true);
  const versions = await readdir(directory); assert.equal(versions.length, 2);
  assert.equal(await readFile(original, 'utf8'), 'first workspace', 'retry must not overwrite prior export');
  assert.deepEqual((await Promise.all(versions.map(v => readFile(join(directory, v, 'seed.txt'), 'utf8')))).sort(), ['first workspace', 'repaired workspace']);
  assert.deepEqual(await verifyDeliveredPackage(acquired.output!), delivered); await f.assertClean();
});

test('untruthful service release cannot unregister while authoritative VM inventory still lists clone', async t => {
  let absent = false;
  const f = await fixture(t, { verifyDestroyed: async () => absent });
  await f.manager.acquire(acquireInput());
  await assert.rejects(f.manager.release(), /Tart still lists/);
  assert.equal(f.service.leases.size, 0, 'service forgot the clone');
  assert.match(await readFile(f.registryPath, 'utf8'), /relay-manager-test/);
  assert.equal((await json(leaseFile(f.manager))).released, undefined);
  absent = true; await f.manager.release(); await f.assertClean();
});

test('R4: a lease that arrives after the caller cancelled relay_acquire is renewed and reported, not left without a heartbeat', async t => {
  const f = await fixture(t, { heartbeatMs: 20 }), controller = new AbortController();
  f.service.acquireHook = async () => { controller.abort(new Error('cancel during allocation')); };
  const failure = await f.manager.acquire(acquireInput(), controller.signal).then(() => assert.fail('a cancelled acquire is still an error'), (error: Error) => error);
  const vm = [...f.service.leases.keys()][0];
  await f.assertRetained(vm);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(f.manager.guestStatus().active, true, 'the owned lease is being renewed');
  assert.ok(f.service.heartbeatCount > 0, 'a retained lease is renewed rather than left to expire unnoticed');
  assert.match(failure.message, /cancel during allocation/);
  assert.match(failure.message, new RegExp(`${vm}.*retained`), 'the error names the VM that is now owned and retained');
  await f.manager.release(); await f.assertClean();
});

test('R5: finish records a declared output that was never produced as incomplete and still delivers and releases', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'missing', path: 'never-written.txt' }, { name: 'artifact', path: 'artifact.txt' }] }));
  await f.stage();
  await f.manager.run(operation('write-artifact', { code: sh([process.execPath, '-e', "require('node:fs').writeFileSync('artifact.txt', 'produced')"]) }));
  const delivered: any = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.execution, 'passed');
  assert.deepEqual(delivered.incompleteExtractions?.map((item: { name: string }) => item.name), ['missing'], 'the result names the output that could not be extracted');
  const versions = await readdir(join(acquired.output!, 'extractions/artifact'));
  assert.equal(await readFile(join(acquired.output!, 'extractions/artifact', versions[0]), 'utf8'), 'produced', 'the outputs that exist are still extracted');
  const events = await Promise.all((await readdir(join(acquired.output!, 'host/events'))).map(path => json(join(acquired.output!, 'host/events', path))));
  assert.equal(events.find(event => event.kind === 'extraction-incomplete')?.details.name, 'missing');
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
});

/** Resolves 'settled' when `work` settles within `ms`, otherwise 'waiting'. */
const settledWithin = (work: Promise<unknown>, ms: number) => Promise.race([work.then(() => 'settled', () => 'settled'), new Promise(done => setTimeout(done, ms, 'waiting'))]);

test('R6: release does not wait behind a cancelled diagnostic command whose guest answer never comes', { timeout: 30000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), hold = deferred(), entered = deferred();
  const acquired = await f.manager.acquire(acquireInput());
  f.service.execHook = async argv => { if (argv.some(arg => arg.includes('/* R6 hang */'))) { entered.resolve(); await hold.promise; } };
  const running = f.manager.run(operation('hang', { diagnostic: true, code: sh([process.execPath, '-e', '/* R6 hang */']), snapshots: undefined }), controller.signal);
  running.catch(() => {});
  await entered.promise;
  const released = f.manager.release();
  controller.abort(new Error('the caller cancelled the command'));
  const observed = await settledWithin(released, 5000);
  hold.resolve(); // let the held guest answer come, so a failing case still tears down
  assert.equal(observed, 'settled', 'a cancelled command must stop waiting for its guest answer, so the queued release can run');
  await released; await f.assertClean();
  assert.equal(f.service.leases.has(acquired.vm!), false);
});

test('R6: release does not wait behind a cancelled recorded run whose receiver answer never comes', { timeout: 30000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), hold = deferred(), entered = deferred();
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  f.service.receiverHook = async () => { entered.resolve(); await hold.promise; };
  const running = f.manager.run(operation('hang'), controller.signal);
  running.catch(() => {});
  await entered.promise;
  const released = f.manager.release();
  controller.abort(new Error('the caller cancelled the command'));
  const observed = await settledWithin(released, 10000);
  hold.resolve(); // let the held guest answer come, so a failing case still tears down
  assert.equal(observed, 'settled', 'a cancelled run must stop waiting for the receiver, so the queued release can run');
  await released; await f.assertClean();
  assert.equal(f.service.leases.has(acquired.vm!), false);
  // The cancelled guest command still runs; let it finish so teardown removes everything it writes.
  while (f.service.receiverActive) await new Promise(done => setTimeout(done, 20));
});

test('R7 (owner decision): a finish whose packaging fails keeps the VM and does not release it', { timeout: 30000, todo: 'waiting for the owner\'s decision: README "Ownership, failure and recovery" documents that a failed delivery retains the VM; this documents the current behavior' }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  await f.manager.run(operation('before-corrupt-state'));
  // A state file whose pulled copy is corrupted makes the verified state pull, and so packaging, fail.
  await writeFile(join(acquired.guestRoot, 'state', 'artifact.txt'), 'state bytes'); f.service.corruptPull = true;
  await assert.rejects(f.manager.finish(), /Extraction inventory mismatch/);
  await f.assertRetained(acquired.vm);
  assert.equal((await json(leaseFile(f.manager))).delivered, undefined, 'nothing was delivered');
  assert.equal(f.service.releaseCalls, 0, 'finish did not release the VM');
  f.service.corruptPull = false; await rm(join(acquired.guestRoot, 'state', 'artifact.txt'));
});

/** Total bytes of the regular files under a directory; 0 when it does not exist. */
async function bytesUnder(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

test('finish keeps one host copy of the relay state: the pulled state is moved into the package, not copied', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  await f.manager.run(operation('state-bytes'));
  const guestState = await bytesUnder(join(acquired.guestRoot, 'state'));
  const delivered = await f.manager.finish(); assert.equal(delivered.deliveryVerified, true);
  const attempts = `${acquired.output}.finalization-attempts`;
  const pulled = (await readdir(attempts)).filter(name => name !== 'previous');
  assert.equal(pulled.length, 1, 'one finalization attempt');
  assert.equal(await bytesUnder(join(attempts, pulled[0])), 0, 'no second copy of the state stays behind in the finalization attempt');
  assert.ok(await bytesUnder(join(acquired.output!, 'state')) >= guestState, 'the package holds the whole state');
  await f.assertClean();
});

test('finish fails before pulling the relay state when the evidence volume has too little free space, names the shortfall and keeps the VM', { timeout: 30000 }, async t => {
  let free = 4096n; const volumes: string[] = [];
  // An injected statfs: 4096 bytes free until the test frees space.
  const statfs = async (path: string) => { volumes.push(path); return { bavail: free / 4096n, bsize: 4096n }; };
  const f = await fixture(t, { statfs } as Partial<ManagerOptions>);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  await shown(f.manager, await f.manager.run(operation('state-needs-space')));
  const guestState = await bytesUnder(join(acquired.guestRoot, 'state'));
  assert.ok(guestState > 4096, 'the fixture state is larger than the free space');
  const pulls = () => f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.startsWith(join(acquired.guestRoot, 'state'))).length;
  const before = pulls();
  const failure = await f.manager.finish().then(() => assert.fail('finish must fail on too little space'), (error: Error) => error);
  assert.match(failure.message, /free space/i);
  assert.match(failure.message, new RegExp(`needs ${guestState} bytes`), 'the diagnostic names what the state needs');
  assert.match(failure.message, /4096 bytes are free/, 'the diagnostic names what is free');
  assert.match(failure.message, new RegExp(`short by ${guestState - 4096} bytes`), 'the diagnostic names the shortfall');
  assert.equal(pulls(), before, 'nothing of the state was pulled');
  await f.assertRetained(acquired.vm);
  assert.ok(volumes.length && volumes.every(path => path.startsWith(join(f.root, 'packages'))), 'free space is measured on the evidence volume');
  free = 1n << 40n;
  const delivered = await f.manager.finish(); assert.equal(delivered.deliveryVerified, true);
  await f.assertClean();
});

/** The ttl_hours of every acquire and heartbeat request the fixture service received. */
const renewals = (service: FixtureService) => ({
  acquire: service.requests.filter(r => r.path === '/acquire').map(r => r.body.ttl_hours as number),
  heartbeats: service.requests.filter(r => r.path.endsWith('/heartbeat')).map(r => r.body.ttl_hours as number),
});

test('H6: acquire and each heartbeat ask vm-service for a 15-minute window, not the lease\'s whole TTL', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.manager.acquire(acquireInput({ ttlHours: 4 }));
  await guestOf(f.manager)?.heartbeat(); await guestOf(f.manager)?.heartbeat();
  const seen = renewals(f.service);
  assert.deepEqual(seen.acquire, [0.25], 'acquire asks for the renewal window');
  assert.equal(seen.heartbeats.length, 2);
  for (const ttl of seen.heartbeats) assert.equal(ttl, 0.25, 'a heartbeat renews the window, not the 4-hour TTL');
  await f.manager.release(); await f.assertClean();
});

test('H6: renewal never reaches past the lease\'s own deadline and stops at its end', { timeout: 30000 }, async t => {
  const f = await fixture(t); // the 60 s fixture timer never fires here; the test drives each heartbeat
  await f.manager.acquire(acquireInput({ ttlHours: 1 }));
  assert.ok(guestOf(f.manager)?.timer, 'renewal is running');
  const enclosure = guestOf(f.manager)?.enclosure;
  // Move the lease's start back so that 10 minutes of its 1-hour TTL remain.
  enclosure.startedAt = new Date(Date.now() - 50 * 60000).toISOString();
  await guestOf(f.manager)?.heartbeat();
  const last = renewals(f.service).heartbeats.at(-1)!;
  assert.ok(last > 9.9 / 60 && last <= 10 / 60, `the renewal ends at the lease's deadline (${last} h), not 15 minutes out`);
  // With 5 minutes left, less than vm-service's 0.1 h minimum renewal, the lease
  // already expires at its deadline, so renewal stops; so it does past the deadline.
  for (const minutesAgo of [55, 61]) {
    enclosure.startedAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
    const count = renewals(f.service).heartbeats.length;
    await guestOf(f.manager)?.heartbeat();
    assert.equal(renewals(f.service).heartbeats.length, count, `no renewal ${60 - minutesAgo} minutes before the lease's deadline`);
    assert.equal(guestOf(f.manager)?.timer, undefined, 'the renewal timer stops');
    assert.equal(f.manager.guestStatus().active, false, 'status shows that renewal stopped');
  }
  await f.assertRetained(); // stopping renewal never releases
  await f.manager.release(); await f.assertClean();
});

for (const pause of ['cleanup', 'settle'] as const) test(`H6: a graceful pause (${pause}) sends one final renewal for the lease's remaining TTL`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput({ ttlHours: 2 }));
  const count = renewals(f.service).heartbeats.length;
  if (pause === 'cleanup') await f.manager.cleanup('Enclosure session ended'); else await f.manager.settle();
  const sent = renewals(f.service).heartbeats.slice(count);
  assert.equal(sent.length, 1, 'one final renewal');
  assert.ok(sent[0] > 1.99 && sent[0] <= 2, `the final renewal covers the remaining TTL (${sent[0]} h)`);
  assert.ok(f.service.leases.has(acquired.vm!), 'the VM is retained');
  const lease = await json(leaseFile(f.manager));
  assert.equal(lease.active, false, 'renewal is paused');
  assert.ok(lease.expiresAt >= Date.now() / 1000 + 1.99 * 3600, 'the recorded expiry is the lease\'s own deadline');
});

// Background step downloads (docs/screenshot-delivery.md §10).
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!await condition()) { if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`); await sleep(10); }
}
/** Holds every archive pull at the fixture service until released. */
function holdStepDownloads(f: Awaited<ReturnType<typeof fixture>>) {
  const hold = deferred(); let held = 0;
  f.service.pullHook = async remote => { if (remote.includes('/.archive-')) { held++; await hold.promise; } };
  return { release: () => { f.service.pullHook = undefined; hold.resolve(); }, get held() { return held; } };
}
const screenshotPulls = (f: Awaited<ReturnType<typeof fixture>>) => f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('.png')).length;
const archivePulls = (f: Awaited<ReturnType<typeof fixture>>) => f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.includes('/.archive-')).length;
const downloadRecord = (hostRoot: string, executionId: string) => json(join(hostRoot, 'host/evidence-downloads', `${executionId}.json`));
/** The guest paths each archive command asked for (AD-8); the archive script's argv carries them from index 8. */
function archiveRequests(f: Awaited<ReturnType<typeof fixture>>) {
  const requests: string[][] = [];
  f.service.execHook = async argv => { if (argv.length > 7 && String(argv[2]).includes('Not a regular file')) requests.push(argv.slice(8)); };
  return requests;
}
/** The files one step download brings: its receiver and execution records, its action record and both snapshots (AD-2). */
const stepFiles = (receipt: any) => [`state/receiver/started/${receipt.executionId}.json`, `state/receiver/receipts/${receipt.executionId}.json`, `state/records/execution/${receipt.executionId}.json`,
  ...receipt.imageEvidence.snapshots.flatMap((sn: any) => [`state/records/action/${sn.actionId}.json`, `state/snapshots/${sn.sessionId}/${sn.fileName}`])].filter((path, at, all) => all.indexOf(path) === at);
const exists = (path: string) => lstat(path).then(() => true, () => false);

test('a run returns before its step downloads; relay_image waits for that one download; over the bound a run waits for the oldest (AD-1 to AD-3)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { downloadBound: 1 }); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const hold = holdStepDownloads(f);
  const first = await f.manager.run(operation('first-download'));
  assert.equal(first.imageDelivery.status, 'pending'); assert.match(first.imageDelivery.image!.imageId, /^image-[a-f0-9]{64}$/);
  assert.equal(await exists(first.imageDelivery.image!.originalPath!), false, 'the run returned before its original reached the host');
  await until(() => hold.held === 1, 'the first step download to reach its archive pull');
  let returned = false;
  const second = f.manager.run(operation('second-download')).then(result => { returned = true; return result; });
  await until(() => f.service.receiverCalls === 2, 'the second run to reach the guest'); await sleep(200);
  assert.equal(returned, false, 'with one download over the bound, the run waits for the oldest');
  assert.equal(f.manager.guestStatus().downloads?.inFlight, 1);
  const image = f.manager.image({ source: 'reference', imageId: first.imageDelivery.image!.imageId });
  hold.release();
  const shownFirst = await image;
  assert.equal(shownFirst.status, 'attached'); assert.deepEqual(shownFirst.image, first.imageDelivery.image);
  await shown(f.manager, await second);
  assert.equal(archivePulls(f), 2, 'one archive per step');
  assert.equal(screenshotPulls(f), 0, 'relay_image waited and filed the original from the step folder instead of transferring again');
  for (const run of [first, await second]) {
    const record = await downloadRecord(acquired.output!, run.executionId!);
    assert.equal(record.status, 'downloaded'); assert.equal(record.key, `${run.imageDelivery.image!.sessionId}/${run.executionId}`); assert.equal(record.image.imageId, run.imageDelivery.image!.imageId);
    assert.ok(record.queuedAt <= record.startedAt && record.startedAt <= record.endedAt);
    const receipt = await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`));
    assert.deepEqual(record.files.map((file: any) => file.path), stepFiles(receipt), 'the step folder holds the files derived from the receipt');
    assert.equal(record.missing, undefined);
    for (const file of record.files) assert.equal(createHash('sha256').update(await readFile(join(acquired.output!, 'host/steps', run.executionId!, file.path))).digest('hex'), file.sha256);
    const before = (await f.manager.image({ source: 'display', sessionId: run.imageDelivery.image!.sessionId!, executionId: run.executionId!, phase: 'before' }));
    assert.equal(before.status, 'attached', 'a before-image is found in the step folder');
  }
  assert.equal(screenshotPulls(f), 0, 'the before-images came from the step folders');
  const delivered = await f.manager.finish(); assert.equal(delivered.snapshots, 'complete'); await f.assertClean();
});

test('a transient download failure waits 1 s, then 3 s, then pauses the downloads until the next relay operation completes (AD-4, DC-5)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const hold = holdStepDownloads(f);
  const a = await f.manager.run(operation('fails-transiently')), b = await f.manager.run(operation('waits-for-resume'));
  await until(() => hold.held === 1, 'the first step download to reach its archive pull');
  f.service.archivePullFailures = 3; hold.release();
  await until(() => f.manager.guestStatus().downloads?.failed === 1, 'the first download to fail');
  const pulls = archivePulls(f); await sleep(300);
  assert.deepEqual({ ...f.manager.guestStatus().downloads, pulls: archivePulls(f) }, { queued: 1, inFlight: 0, downloaded: 0, failed: 1, cancelled: 0, coalesced: 0, paused: true, state: 'open', pulls }, 'the worker is paused');
  const failed = await downloadRecord(acquired.output!, a.executionId!);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'transfer-failed');
  assert.ok(Date.parse(failed.endedAt) - Date.parse(failed.startedAt) >= 4000, 'the download waited 1 s, then 3 s, between its three archive pulls');
  await f.manager.extract([]);
  await until(() => f.manager.guestStatus().downloads?.downloaded === 1, 'the paused download to resume');
  assert.equal((await downloadRecord(acquired.output!, b.executionId!)).status, 'downloaded');
  assert.equal(f.manager.guestStatus().downloads?.paused, false);
  const delivered = await f.manager.finish(); assert.equal(delivered.snapshots, 'complete'); await f.assertClean();
});

test('finish waits for the download in flight, coalesces the queued steps into its own archive, and the package is complete (AD-5, AD-9, DC-11)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { downloadRetryDelaysMs: [] }); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const hold = holdStepDownloads(f);
  const runs = [await f.manager.run(operation('in-flight')), await f.manager.run(operation('queued-1')), await f.manager.run(operation('queued-2'))];
  await until(() => hold.held === 1, 'the first step download to reach its archive pull');
  let finished = false;
  const finishing = f.manager.finish().then(result => { finished = true; return result; });
  await sleep(300); assert.equal(finished, false, 'finish waits while a download is in flight');
  assert.equal(f.manager.guestStatus().downloads?.state, 'closing'); assert.equal(f.manager.guestStatus().downloads?.coalesced, 2);
  const requests = archiveRequests(f);
  f.service.archivePullFailures = 3; hold.release();
  const delivered = await finishing;
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.snapshots, 'complete');
  assert.deepEqual(await verifyDeliveredPackage(acquired.output!), delivered);
  assert.deepEqual(await Promise.all(runs.map(async run => (await downloadRecord(acquired.output!, run.executionId!)).status)), ['failed', 'coalesced', 'coalesced']);
  const archived = requests.flat();
  for (const run of runs) {
    const receipt = await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`));
    for (const path of stepFiles(receipt).filter(path => !path.startsWith('state/receiver/receipts/'))) assert.ok(archived.includes(path.slice('state/'.length)), `the finish archive holds ${path}`);
  }
  assert.equal(await exists(join(acquired.output!, 'host/steps')), false, 'the package holds no step folders');
  for (const run of runs) {
    const after = (await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`))).imageEvidence.snapshots.find((s: any) => s.phase === 'after');
    assert.deepEqual(await readFile(join(acquired.output!, 'state/snapshots', run.imageDelivery.image!.sessionId!, after.fileName)), Buffer.from(png, 'base64'), 'the state pull fetched what the downloads did not');
  }
  await f.assertClean();
});

test('release and a recording reset wait for every queued download before touching the guest state (AD-5)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  let hold = holdStepDownloads(f);
  const beforeReset = await f.manager.run(operation('before-reset'));
  await until(() => hold.held === 1, 'the step download to reach its archive pull');
  let reset = false;
  const resetting = f.manager.stage({ resetRecording: true }).then(() => { reset = true; });
  await sleep(300); assert.equal(reset, false, 'the reset waits for the download');
  hold.release(); await resetting;
  assert.equal((await downloadRecord(acquired.output!, beforeReset.executionId!)).status, 'downloaded');
  assert.equal(await exists(join(acquired.output!, 'host/steps')), false, 'the reset recording keeps no step folders');
  assert.notEqual(f.manager.guestStatus().output, acquired.output);
  hold = holdStepDownloads(f);
  const beforeRelease = await f.manager.run(operation('before-release'));
  const recording = f.manager.guestStatus().output!;
  await until(() => hold.held === 1, 'the step download to reach its archive pull');
  let released = false;
  const releasing = f.manager.release().then(() => { released = true; });
  await sleep(300); assert.equal(released, false, 'release waits for the download');
  hold.release(); await releasing;
  assert.equal((await downloadRecord(recording, beforeRelease.executionId!)).status, 'downloaded');
  assert.equal(await exists(join(recording, 'host/steps')), false, 'the released recording keeps no step folders');
  await f.assertClean();
});

test('finish takes the files the step downloads brought and archives only the rest (AD-6, AD-9, DC-6)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const runs = [];
  for (const id of ['held-1', 'held-2']) { const run = await f.manager.run(operation(id)); await shown(f.manager, run); runs.push(run); }
  const pulls = screenshotPulls(f), requests = archiveRequests(f);
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.snapshots, 'complete');
  assert.deepEqual(await verifyDeliveredPackage(acquired.output!), delivered);
  // The fixture captures one constant PNG, so the held originals match every snapshot, before and after, by hash.
  assert.equal(screenshotPulls(f) - pulls, 0, 'no snapshot is pulled again');
  const events = await Promise.all((await readdir(join(acquired.output!, 'host/events'))).map(name => json(join(acquired.output!, 'host/events', name))));
  assert.equal(events.find(event => event.kind === 'state-reused')?.details.files, 12, 'two steps, each with its receiver start, receipt, execution and action records and two snapshots');
  const stepPaths = (await Promise.all(runs.map(async run => stepFiles(await json(join(acquired.output!, 'host/receiver-receipts', `${run.executionId}.json`)))))).flat();
  assert.deepEqual(requests.flat().filter(path => stepPaths.includes(`state/${path}`)), [], 'the finish archive holds only files no step download brought');
  assert.equal(await exists(join(acquired.output!, 'host/steps')), false, 'the package holds no step folders');
  await f.assertClean();
});

test('a step file that changed after its download comes from the guest at finish (AD-6)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('changed-after-download')); await shown(f.manager, run);
  const guestRoot = guestOf(f.manager)?.current().guestRoot as string;
  const started = join(guestRoot, 'state/receiver/started', `${run.executionId}.json`);
  const changed = `${JSON.stringify(await json(started), null, 2)}\n`; await writeFile(started, changed);
  const requests = archiveRequests(f);
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true);
  assert.ok(requests.flat().includes(`receiver/started/${run.executionId}.json`), 'the finish archive holds the changed file');
  assert.equal(await readFile(join(acquired.output!, 'state/receiver/started', `${run.executionId}.json`), 'utf8'), changed);
  await f.assertClean();
});

test('cleanup aborts the download in flight and releases the owner lock without waiting for the guest (AD-5)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const hold = holdStepDownloads(f);
  const run = await f.manager.run(operation('aborted-download'));
  await until(() => hold.held === 1, 'the step download to reach its archive pull');
  await f.manager.cleanup('shutdown during a download');
  const sibling = new RelayManager(f.options);
  try { await sibling.initialize(); assert.equal(sibling.guestStatus().vm, acquired.vm, 'the owner lock was released'); }
  finally { await sibling.cleanup('sibling check'); }
  hold.release(); await sleep(300);
  assert.equal(await exists(join(acquired.output!, 'host/evidence-downloads', `${run.executionId}.json`)), false, 'a closed queue writes nothing');
  assert.equal(await exists(run.imageDelivery.image!.originalPath!), false, 'an aborted download does not publish');
});

// DC-20: one session holds several guests at once.
const stageGuest = (f: Awaited<ReturnType<typeof fixture>>, guest: string) => f.manager.stage({ guest, cuaDriver: f.driver, nodePath: process.execPath });
/** Rejects when `work` has not settled within `ms`, so a lost concurrency shows as a failure rather than a hang. */
const within2 = <T>(work: Promise<T>, ms: number, what: string) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms).unref())]);

test('two guests in one session run at the same time and finish independently, each with its own evidence (DC-20)', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.manager.acquire(acquireInput({ extractions: [{ name: 'artifact', path: 'artifact.txt' }] })), f.manager.acquire(acquireInput({ extractions: [{ name: 'artifact', path: 'artifact.txt' }] }))]);
  assert.deepEqual([first.guest, second.guest].sort(), ['manager-test-1', 'manager-test-2']);
  assert.notEqual(first.vm, second.vm); assert.notEqual(first.output, second.output); assert.notEqual(first.purpose, second.purpose);
  assert.equal(f.service.leases.size, 2);
  const status = f.manager.status();
  assert.deepEqual(status.guests.map(guest => guest.guest).sort(), ['manager-test-1', 'manager-test-2']); assert.equal(status.active, true); assert.equal(status.maxGuests, 4);
  assert.equal((await readFile(f.registryPath, 'utf8')).split('\n').filter(line => line.includes('vm-service relay-manager-test-')).length, 2, 'each guest has its own registry row');
  for (const guest of [first, second]) assert.equal((await json(leaseFile(f.manager, guest.guest!))).lease.vm, guest.vm, `guest ${guest.guest} has its own ownership record`);
  await assert.rejects(f.manager.run(operation('ambiguous')), /Name the guest this call acts on: this session holds manager-test-1, manager-test-2/);
  await Promise.all([stageGuest(f, first.guest!), stageGuest(f, second.guest!)]);
  // Each guest's first command waits until the other guest's command has reached its receiver: only concurrent calls get past it.
  const both = deferred(); let arrived = 0;
  f.service.receiverHook = async () => { if (++arrived === 2) both.resolve(); await both.promise; };
  const write = (guest: string, text: string) => f.manager.run(operation(`write-${guest}`, { guest, code: sh([process.execPath, '-e', `require('fs').appendFileSync('artifact.txt', ${JSON.stringify(text)})`]) }));
  const [one, two] = await within2(Promise.all([write(first.guest!, 'one'), write(second.guest!, 'two')]), 20000, 'concurrent runs on two guests');
  f.service.receiverHook = undefined;
  assert.equal(f.service.maxReceiverActive, 2, 'the two guests\' commands ran at the same time');
  assert.equal(one.guest, first.guest); assert.equal(two.guest, second.guest);
  assert.equal(one.evidencePath, first.output); assert.equal(two.evidencePath, second.output);
  // Interleaved: more commands on both guests, sent together.
  const more = await Promise.all([write(first.guest!, '|one-again'), write(second.guest!, '|two-again'), write(first.guest!, '|one-last')]);
  for (const result of more) assert.equal(result.outcome.kind, 'completed', JSON.stringify(result.outcome));
  assert.equal(await readFile(join(first.workspace, 'artifact.txt'), 'utf8'), 'one|one-again|one-last', 'calls on one guest kept their order');
  assert.equal(await readFile(join(second.workspace, 'artifact.txt'), 'utf8'), 'two|two-again');
  const image = await f.manager.image({ source: 'reference', imageId: two.imageDelivery.image!.imageId }, undefined, second.guest);
  assert.equal(image.status, 'attached', JSON.stringify(image));
  // Finishing the first guest leaves the second running.
  const delivered = await f.manager.finish(undefined, first.guest);
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.execution, 'passed');
  assert.deepEqual(await verifyDeliveredPackage(first.output!), delivered);
  assert.equal(f.service.leases.has(first.vm!), false); assert.equal(f.service.leases.has(second.vm!), true);
  assert.deepEqual(f.manager.status().guests.map(guest => guest.guest), [second.guest]);
  assert.equal(f.manager.guestStatus(second.guest).active, true, 'the second guest is still renewed');
  assert.equal(await json(leaseFile(f.manager, first.guest!)), null);
  assert.equal((await json(`${first.output}.lifecycle.json`)).guest, first.guest);
  await assert.rejects(f.manager.run(operation('after-finish', { guest: first.guest })), /holds no guest named "manager-test-1"; it holds manager-test-2/);
  assert.equal((await write(second.guest!, '|two-after')).outcome.kind, 'completed');
  const second_ = await f.manager.finish(undefined, second.guest);
  assert.equal(second_.deliveryVerified, true); assert.equal(second_.execution, 'passed');
  assert.deepEqual(await verifyDeliveredPackage(second.output!), second_);
  const extracted = async (output: string) => { const dir = join(output, 'extractions', 'artifact'); return Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), 'utf8'))); };
  assert.deepEqual(await extracted(first.output!), ['one|one-again|one-last']);
  assert.deepEqual(await extracted(second.output!), ['two|two-again|two-after']);
  await f.assertClean(); assert.equal(f.service.releaseCalls, 2);
});

test('calls on one guest keep their order while another guest\'s calls run (DC-20)', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const a = await f.manager.acquire(acquireInput()), b = await f.manager.acquire(acquireInput());
  await stageGuest(f, a.guest!); await stageGuest(f, b.guest!);
  const order: string[] = [], held = deferred();
  f.service.execHook = async argv => { if (argv[0] === '/usr/bin/env' && (await readFile(argv.at(-1)!, 'utf8')).includes('a-first')) await held.promise; };
  const run = (guest: string, id: string) => f.manager.run(operation(id, { guest, code: sh([process.execPath, '-e', `console.log(${JSON.stringify(id)})`]) })).then(result => { order.push(id); return result; });
  const first = run(a.guest!, 'a-first'), second = run(a.guest!, 'a-second');
  // The first call on guest A is held at its receiver; guest B is not held up by it.
  assert.equal((await within2(run(b.guest!, 'b-only'), 20000, 'a call on another guest')).outcome.kind, 'completed');
  assert.deepEqual(order, ['b-only']);
  assert.equal(f.service.requests.filter(r => r.path === `/vms/${a.vm}/exec` && r.body.argv[0] === '/usr/bin/env').length, 1, 'the second call on guest A waits for the first');
  held.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['b-only', 'a-first', 'a-second']);
  await f.manager.release(a.guest); await f.manager.release(b.guest); await f.assertClean();
});

test('a session holds at most maxGuests guests; acquisition beyond it is refused naming them, and a released guest\'s name is never reused (DC-20)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { maxGuests: 2 });
  const a = await f.manager.acquire(acquireInput()), b = await f.manager.acquire(acquireInput());
  await assert.rejects(f.manager.acquire(acquireInput()), /This session already holds 2 guests, the most MCP_RELAY_MAX_GUESTS allows \(2\): manager-test-1, manager-test-2\. .*nothing was acquired/);
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 2, 'the refused acquisition never reached vm-service');
  await f.manager.release(a.guest);
  assert.deepEqual(f.manager.status().guests.map(guest => guest.guest), [b.guest]);
  const c = await f.manager.acquire(acquireInput());
  assert.equal(c.guest, 'manager-test-3');
  await f.manager.release(b.guest); await f.manager.release(c.guest); await f.assertClean();
});

test('a call naming a guest the session does not hold is refused and changes nothing (DC-20)', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const a = await f.manager.acquire(acquireInput());
  const requests = f.service.requests.length;
  for (const call of [
    () => f.manager.stage({ guest: 'other-1', cuaDriver: f.driver }),
    () => f.manager.run(operation('nowhere', { guest: 'other-1' })),
    () => f.manager.extract([], undefined, 'other-1'),
    () => f.manager.finish(undefined, 'other-1'),
    () => f.manager.release('other-1'),
    () => f.manager.consoleResolve(undefined, 'other-1'),
    () => f.manager.probe('guest', 'other-1'),
  ]) await assert.rejects(call(), /This session holds no guest named "other-1"; it holds manager-test-1\. relay_acquire answers each guest's name/);
  const image = await f.manager.image({ source: 'reference', imageId: `image-${'0'.repeat(64)}` }, undefined, 'other-1');
  assert.equal(image.status, 'stale-reference'); assert.match(image.diagnostic!, /no guest named "other-1"/);
  const viaTool = await relayCall(f.manager, { action: 'run', guest: 'other-1', language: 'shell', inline: true, code: 'true' }).catch(error => error);
  assert.match(String(viaTool), /no guest named "other-1"/);
  assert.equal(f.service.requests.length, requests, 'nothing reached vm-service');
  await f.assertRetained(a.vm);
  await f.manager.release(a.guest); await f.assertClean();
  const none = await relayCall(f.manager, { action: 'release', guest: 'manager-test-1' });
  assert.equal(none.isError, true); assert.match(none.text, /owns no lease/);
});

test('a restarted session restores both its guests by name, pauses both at shutdown and replays nothing (DC-20)', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const a = await f.manager.acquire(acquireInput()), b = await f.manager.acquire(acquireInput());
  await stageGuest(f, a.guest!); await stageGuest(f, b.guest!);
  const ranA = await f.manager.run(operation('a-before', { guest: a.guest })), ranB = await f.manager.run(operation('b-before', { guest: b.guest }));
  await f.manager.cleanup('restart with two guests');
  for (const guest of [a, b]) {
    const record = await json(leaseFile(f.manager, guest.guest!));
    assert.equal(record.active, false, `${guest.guest} renewal paused`); assert.equal(record.lease.vm, guest.vm);
    const events = await Promise.all((await readdir(join(guest.output!, 'host/events'))).map(name => json(join(guest.output!, 'host/events', name))));
    assert.ok(events.some(event => event.kind === 'renewal-paused' && /restart with two guests/.test(event.details.reason)), `${guest.guest} records the pause`);
  }
  assert.equal(f.service.releaseCalls, 0);
  const recovered = new RelayManager(f.options);
  try {
    await recovered.initialize();
    assert.deepEqual(recovered.status().guests.map(guest => [guest.guest, guest.vm, guest.staged]), [[a.guest, a.vm, true], [b.guest, b.vm, true]]);
    assert.equal(f.service.receiverCalls, 2, 'restoring replays nothing');
    const [nextA, nextB] = await Promise.all([recovered.run(operation('a-after', { guest: a.guest })), recovered.run(operation('b-after', { guest: b.guest }))]);
    assert.equal(nextA.outcome.kind, 'completed'); assert.equal(nextB.outcome.kind, 'completed');
    assert.notEqual(nextA.executionId, ranA.executionId); assert.notEqual(nextB.executionId, ranB.executionId);
    assert.equal(f.service.receiverCalls, 4);
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 2, 'nothing was acquired again');
    assert.equal((await recovered.finish(undefined, b.guest)).execution, 'passed');
    assert.deepEqual(recovered.status().guests.map(guest => guest.guest), [a.guest]);
    assert.equal((await recovered.finish(undefined, a.guest)).execution, 'passed');
    assert.deepEqual(recovered.status().guests, []);
  } finally { await recovered.release().catch(() => {}); await recovered.cleanup('recovered teardown'); await f.manager.initialize(); }
  await f.assertClean();
});

test('a session state written before DC-20 is restored as one named guest (DC-20)', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput());
  await f.manager.cleanup('upgrade');
  // A relay before DC-20 kept its one enclosure in the session's lease.json.
  await writeFile(join(f.manager.root, 'lease.json'), await readFile(leaseFile(f.manager), 'utf8'));
  await rm(join(f.manager.root, 'guests'), { recursive: true });
  const recovered = new RelayManager(f.options);
  try {
    await recovered.initialize();
    assert.equal(recovered.guestStatus(G).vm, acquired.vm);
    assert.equal(await json(join(recovered.root, 'lease.json')), null, 'the old record is emptied once the guest holds it');
    assert.equal((await json(leaseFile(recovered))).lease.vm, acquired.vm);
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
    await recovered.release(G);
  } finally { await recovered.cleanup('migrated teardown'); await f.manager.initialize(); }
  await f.assertClean();
});

// DC-22: an acquisition waits for a host at capacity.
const capacityRefused = { status: 409, body: { error: 'macOS VM limit reached (2 active); release one first; host-wide Virtualization.framework guests: 2 (0 not ours)' } };
const acquisitions = (f: { service: FixtureService }) => f.service.requests.filter(r => r.path === '/acquire').length;
const events = async (output: string) => Promise.all((await readdir(join(output, 'host/events'))).map(name => json(join(output, 'host/events', name))));

test('only vm-service\'s macOS VM limit refusal is a capacity refusal (DC-22)', () => {
  const error = (status: number, body: unknown) => new VmServiceError(`vm-service /acquire: HTTP ${status}`, status, JSON.stringify(body));
  assert.equal(capacityRefusal(error(409, capacityRefused.body)), true);
  assert.equal(capacityRefusal(error(409, { ...capacityRefused.body, outcome: 'uncertain' })), false, 'an uncertain outcome may have reserved a lease');
  assert.equal(capacityRefusal(error(409, { error: "purpose 'relay-x' already leased on image macos26: vm-1" })), false);
  assert.equal(capacityRefusal(error(400, capacityRefused.body)), false);
  assert.equal(capacityRefusal(new Error('macOS VM limit reached')), false);
});

test('a host at capacity twice, then free: relay_acquire waits, is granted and says how long it waited (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 10000, capacityRetryMs: 100 });
  f.service.acquireRefusal = capacityRefused; f.service.acquireRefusals = 2;
  const acquired = await f.manager.acquire(acquireInput());
  assert.equal(acquisitions(f), 3, 'refused twice, granted the third time');
  assert.ok(acquired.waitedForCapacityMs >= 200 && acquired.waitedForCapacityMs < 5000, String(acquired.waitedForCapacityMs));
  assert.equal(acquired.guest, G); assert.equal(f.service.leases.size, 1); assert.equal(acquired.waitingForCapacity, undefined);
  const kinds = (await events(acquired.output!)).map(event => event.kind);
  assert.ok(kinds.includes('capacity-wait') && kinds.includes('capacity-granted'), kinds.join());
  assert.equal(f.manager.guestStatus().active, true);
  await f.manager.release(); await f.assertClean();
});

test('a guest waiting for capacity holds its name and says so in status and in the limit refusal (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { maxGuests: 1, capacityWaitMs: 10000, capacityRetryMs: 50 });
  f.service.acquireRefusal = capacityRefused; f.service.acquireRefusals = 1000;
  const waiting = f.manager.acquire(acquireInput());
  const deadline = Date.now() + 5000;
  while (!f.manager.status().guests[0]?.waitingForCapacity && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  const status = f.manager.status().guests[0]!;
  assert.equal(status.guest, G); assert.match(status.waitingForCapacity!.reason, /macOS VM limit reached/); assert.equal(status.active, false);
  await assert.rejects(f.manager.acquire(acquireInput()), /the most MCP_RELAY_MAX_GUESTS allows \(1\): manager-test-1 \(waiting for capacity\)/);
  f.service.acquireRefusals = 0;
  const acquired = await waiting;
  assert.ok(acquired.waitedForCapacityMs > 0);
  await f.manager.release(); await f.assertClean();
});

test('a host still at capacity when the wait runs out refuses with vm-service\'s reason and the time waited (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 300, capacityRetryMs: 100 });
  f.service.acquireRefusal = capacityRefused;
  await assert.rejects(f.manager.acquire(acquireInput()), /HTTP 409: .*macOS VM limit reached \(2 active\).*; waited 0\.[3-9] s for capacity, the most MCP_RELAY_CAPACITY_WAIT allows \(0\.3 s\), so nothing was acquired/s);
  assert.ok(acquisitions(f) >= 3, String(acquisitions(f)));
  assert.equal(f.service.leases.size, 0);
  assert.deepEqual(f.manager.status().guests, [], 'nothing was acquired, so no guest stays');
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});

test('a session that ends while an acquisition waits for capacity ends at once, with nothing acquired (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 600000, capacityRetryMs: 60000 });
  f.service.acquireRefusal = capacityRefused;
  const waiting = f.manager.acquire(acquireInput());
  const failed = waiting.then(() => assert.fail('nothing should be acquired'), error => error);
  const deadline = Date.now() + 5000;
  while (!f.manager.status().guests[0]?.waitingForCapacity && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  const started = Date.now();
  await f.manager.cleanup('session ended during the wait');
  assert.ok(Date.now() - started < 5000, `cleanup took ${Date.now() - started} ms`);
  assert.match(String(await failed), /The relay session ended while the acquisition waited .* s for capacity .*nothing was acquired/);
  assert.equal(acquisitions(f), 1); assert.equal(f.service.leases.size, 0);
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});

test('a cancelled acquisition stops waiting for capacity, with nothing acquired (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 600000, capacityRetryMs: 60000 });
  f.service.acquireRefusal = capacityRefused;
  const controller = new AbortController();
  const waiting = f.manager.acquire(acquireInput(), controller.signal).then(() => assert.fail('nothing should be acquired'), error => error);
  const deadline = Date.now() + 5000;
  while (!f.manager.status().guests[0]?.waitingForCapacity && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  controller.abort(new Error('Cancelled by the client'));
  assert.match(String(await waiting), /Cancelled by the client while the acquisition waited/);
  assert.equal(acquisitions(f), 1); assert.deepEqual(f.manager.status().guests, []);
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});

test('a 409 that is not a capacity refusal, or a wait of 0, is not retried (DC-22)', { timeout: 30000 }, async t => {
  const f = await fixture(t, { capacityWaitMs: 10000, capacityRetryMs: 50 });
  f.service.acquireRefusal = { status: 409, body: { error: "purpose 'relay-x' already leased on image ubuntu2404: vm-1" } };
  await assert.rejects(f.manager.acquire(acquireInput()), /HTTP 409: .*already leased/);
  assert.equal(acquisitions(f), 1, 'asked once');
  f.service.acquireRefusal = { status: 409, body: { ...capacityRefused.body, outcome: 'uncertain' } };
  await assert.rejects(f.manager.acquire(acquireInput()), /macOS VM limit reached/);
  assert.equal(acquisitions(f), 2, 'an uncertain refusal is not asked again');
  const none = await fixture(t, { capacityWaitMs: 0, capacityRetryMs: 50 });
  none.service.acquireRefusal = capacityRefused;
  await assert.rejects(none.manager.acquire(acquireInput()), error => !/waited/.test(String(error)) && /macOS VM limit reached/.test(String(error)));
  assert.equal(acquisitions(none), 1, 'MCP_RELAY_CAPACITY_WAIT=0 does not wait');
});

test('relay_stage waits for the guest\'s cua-driver to take a screenshot before it returns (DC-24)', async t => {
  const f = await fixture(t);
  await f.manager.acquire(acquireInput());
  await writeFile(join(f.root, 'capture-fails-count'), '3');
  const staged = await f.stage() as any;
  assert.equal(staged.snapshots.taken, true);
  assert.equal(await readFile(join(f.root, 'capture-fails-count'), 'utf8'), '0', 'the stage asked until the daemon answered');
  assert.equal((await readFile(join(f.root, 'probes.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const run = await f.manager.run(operation('first-run'));
  assert.equal(run.outcome.kind, 'completed', JSON.stringify(run.outcome));
  await f.manager.release(); await f.assertClean();
});

test('relay_stage refuses when the guest\'s cua-driver never takes a screenshot, and a later stage succeeds (DC-24)', async t => {
  const f = await fixture(t, { captureReadyWaitMs: 300 });
  const acquired = await f.manager.acquire(acquireInput());
  await writeFile(join(f.root, 'capture-fails'), '');
  await assert.rejects(f.stage(), /relay_stage waited \d+ s for ubuntu2404's cua-driver to take a screenshot.*Cua Driver daemon is not running.*diagnostic: true/s);
  assert.equal(f.manager.guestStatus().staged, false); assert.equal(f.service.receiverCalls, 0);
  await f.assertRetained(acquired.vm);
  await rm(join(f.root, 'capture-fails'));
  await f.stage(); assert.equal(f.manager.guestStatus().staged, true);
  await f.manager.release(); await f.assertClean();
});

test('relay_stage asks for no screenshot when the image lists no capture software (DC-24)', async t => {
  const f = await fixture(t);
  f.service.catalog = { schemaVersion: 1, images: [{ image: 'ubuntu2404', os: 'linux', architecture: 'arm64', applications: [{ id: 'dpkg:nodejs', name: 'Node.js', aliases: ['node'], version: '22.0.0' }] }] };
  await f.manager.acquire(acquireInput());
  await writeFile(join(f.root, 'capture-fails'), '');
  const staged = await f.stage() as any;
  assert.equal(staged.snapshots.taken, false);
  assert.equal(await exists(join(f.root, 'probes.jsonl')), false);
  await f.manager.release(); await f.assertClean();
});
