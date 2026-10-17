import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { RelayManager, type AcquireInput, type ManagerOptions, type RunInput } from '../src/manager.js';
import { Registry } from '../src/registry.js';
import { VmService, type VmLease } from '../src/vm-service.js';
import { verifyDeliveredPackage } from '../src/package.js';
import { targetLaunches, type Target } from '../src/targets.js';
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
const mcpHostBundle = fileURLToPath(new URL('../dist/mcp-host.mjs', import.meta.url));
const mcpFixture = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
/** The browser targets launch SDK fixture servers; cua keeps its real launch (`<cuaDriver> mcp`), which the fake driver answers with the same fixture. */
const fixtureLaunches = (log: string) => (context: Parameters<typeof targetLaunches>[0]) => {
  const real = targetLaunches(context);
  const fixture = (name: Target) => ({ command: context.node, args: [mcpFixture, name], cwd: context.workspace, env: { FIXTURE_LOG: log } });
  return { cua: { ...real.cua, env: { FIXTURE_LOG: log } }, playwright: fixture('playwright'), 'chrome-devtools': fixture('chrome-devtools') };
};
const reason = 'Exercise isolated protocol fixtures, never the real desktop';
const acquireInput = (patch: Partial<AcquireInput> = {}): AcquireInput => ({ image: 'ubuntu2404', task: 'manager-test', extractions: [], ...patch });
const operation = (id: string, patch: Partial<RunInput> = {}): RunInput => ({ because: reason, kind: 'exec', argv: [process.execPath, '-e', 'console.log("test output")'], step: { id, title: id, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 }, ...patch });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
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
  /** Refuses every acquisition with this status and body, as vm-service refuses one it cannot give. */
  acquireRefusal?: { status: number; body: unknown };
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
    if (path === '/images') return this.respond(res, 200, { images: { ubuntu2404: { kind: 'linux', base_available: true }, missing: { base_available: false } }, capacity: { macos_running: 0, macos_limit: 2 } });
    if (path === '/vms') return this.respond(res, 200, { vms: this.hideLeases ? {} : Object.fromEntries(this.leases), limits: { max_macos_running: 2, grace_hours: 1 }, pilot_repo: this.root, port: 0 });
    if (path === '/acquire') {
      if (this.acquireRefusal) return this.respond(res, this.acquireRefusal.status, this.acquireRefusal.body);
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
    assert.ok(['node', process.execPath, '/bin/mkdir', '/bin/sh', '/usr/bin/env', join(this.root, 'fake-cua')].includes(argv[0]), `Unexpected fixture executable: ${argv[0]}`);
    if (argv[0] === '/bin/sh') { assert.equal(argv[2], 'cd "$1" || exit; shift; exec "$@"'); assert.ok(argv[4].startsWith('/var/tmp/')); }
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
        const child = spawn(argv[0], argv.slice(1), { cwd: this.root, env: { PATH: process.env.PATH, HOME: this.root }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // Stop any guest MCP host a test left running (finish/release normally stop it).
    for (const root of this.guestRoots) { try { execFileSync(process.execPath, [mcpHostBundle, 'stop', join(root, 'mcp')], { stdio: 'ignore', timeout: 20000 }); } catch {} await rm(root, { recursive: true, force: true }); }
  }
}

async function fixture(t: TestContext, patch: Partial<ManagerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-relay-manager-')));
  const registryPath = join(root, 'AGENTS.md'); await writeFile(registryPath, registryText);
  const service = new FixtureService(root), vm = await service.start();
  const mcpLog = join(root, 'mcp-calls.jsonl');
  const options: ManagerOptions = { project: root, sessionId: randomUUID(), stateRoot: join(root, 'state'), outputRoot: join(root, 'packages'), registry: new Registry(registryPath), vm, runtimeBundle: bundle, heartbeatMs: 60000, verifyDestroyed: async name => !service.leases.has(name), mcpHostBundle, targetLaunches: fixtureLaunches(mcpLog), targetPackages: { playwright: { entry: '', packages: [] }, 'chrome-devtools': { entry: '', packages: [] } }, packageCache: join(root, 'package-cache'), ...patch };
  const manager = new RelayManager(options);
  t.after(async () => { service.releaseFailures = 0; service.failHeartbeat = false; service.failGet = false; service.hideLeases = false; await manager.release(); await manager.cleanup('test teardown'); await service.close(); await rm(root, { recursive: true, force: true }); });
  const driver = join(root, 'fake-cua');
  await writeFile(driver, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version'){console.log('fixture-cua 1.0');process.exit(0);}if(process.argv[2]==='mcp'){process.argv[2]='cua';import(${JSON.stringify(mcpFixture)});return;}if(process.argv[2]!=='call'||process.argv[3]!=='get_desktop_state'||process.argv[4]!=='--json')process.exit(99);const a=JSON.parse(process.argv[5]);fs.appendFileSync(${JSON.stringify(join(root, 'captures.jsonl'))},JSON.stringify(a)+'\\n');fs.writeFileSync(a.screenshot_out_file,Buffer.from('${png}','base64'));console.log(JSON.stringify({screenshot_file_path:a.screenshot_out_file}));`);
  await chmod(driver, 0o700);
  const stage = () => manager.stage({ cuaDriver: driver, nodePath: process.execPath });
  const assertClean = async () => {
    assert.deepEqual(manager.status(), { active: false }); assert.equal(service.leases.size, 0);
    assert.equal(await readFile(registryPath, 'utf8'), registryText);
    assert.equal(await json(join(manager.root, 'lease.json')), null);
  };
  const assertRetained = async (vm: string | undefined = manager.status().vm) => {
    assert.equal(manager.status().vm, vm); assert.ok(vm); assert.equal(service.leases.has(vm), true);
    assert.equal(service.releaseCalls, 0);
    assert.equal((await json(join(manager.root, 'lease.json'))).lease.vm, vm);
    assert.notEqual(await readFile(registryPath, 'utf8'), registryText);
  };
  const mcpCalls = async () => (await readFile(mcpLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, manager, service, options, driver, stage, assertClean, assertRetained, registryPath, mcpCalls };
}

test('real HTTP service, receiver and Registry: acquire → stage → exec/script/code → extraction → verified finish', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'input')); await writeFile(join(f.root, 'input', 'seed.txt'), 'workspace seed');
  await writeFile(join(f.root, 'support.txt'), 'support bytes');
  await writeFile(join(f.root, 'script.js'), "require('node:fs').writeFileSync('artifact.txt', 'script artifact');console.log('script result')");
  const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'artifact', path: 'artifact.txt' }], fullWorkspace: true, ttlHours: 0.5 }));
  const hostRoot = f.manager.status().output!;
  assert.match(await readFile(f.registryPath, 'utf8'), /vm-service relay-manager-test-/);
  const lease = await json(join(f.manager.root, 'lease.json'));
  assert.equal(Object.hasOwn(lease, 'because'), false);
  assert.equal(lease.lease.vm, acquired.vm); assert.equal(lease.row.machine, `127.0.0.1 (vm-service ${lease.purpose})`);
  await f.manager.stage({ workspace: 'input', files: [{ local: 'support.txt', path: 'nested/support.txt' }], cuaDriver: f.driver, nodePath: process.execPath });
  assert.equal(await readFile(join(acquired.guestRoot, 'support/nested/support.txt'), 'utf8'), 'support bytes');
  assert.equal(await readFile(join(acquired.workspace, 'seed.txt'), 'utf8'), 'workspace seed');
  for (const run of [operation('exec'), operation('script', { kind: 'script', language: 'javascript', localPath: 'script.js' }), operation('code', { kind: 'code', language: 'javascript', code: "console.log(require('node:fs').readFileSync('artifact.txt','utf8'))" })]) {
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
  const hostRoot = f.manager.status().output!;
  assert.deepEqual(acquired.declarations, declarations);
  assert.equal(acquired.vm, f.manager.status().vm);
  assert.match(await readFile(f.registryPath, 'utf8'), /vm-service relay-manager-test-/);
  assert.equal(Object.hasOwn(await json(join(f.manager.root, 'lease.json')), 'because'), false);
  await writeFile(join(f.root, 'tool-script.js'), "require('node:fs').appendFileSync('artifact.txt', '|script');console.log('script result')");
  const staged = await execute({ action: 'stage', cuaDriver: f.driver, nodePath: process.execPath });
  assert.equal(staged.staged, true); assert.equal(staged.workspace, acquired.workspace);
  f.service.receiverHook = async () => { await f.service.heartbeatDuringExec.promise; };
  const runs: Extract<RelayInput, { action: 'run' }>[] = [
    { action: 'run', reason: why('exec'), kind: 'exec', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('artifact.txt', 'exec artifact');console.log('exec result')"], step: { ...operation('tool-exec').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
    { action: 'run', reason: why('script'), kind: 'script', localPath: 'tool-script.js', language: 'javascript', step: { ...operation('tool-script').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
    { action: 'run', reason: why('code'), kind: 'code', code: "require('node:fs').appendFileSync('artifact.txt', '|code');console.log('code result')", language: 'javascript', step: { ...operation('tool-code').step, expected: 'Fixture command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } },
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
  const extracted = await execute({ action: 'extract', names: ['artifact'] });
  assert.equal(extracted.length, 1); assert.equal(extracted[0].facts.length, 1);
  assert.equal(extracted[0].name, 'artifact'); assert.equal(extracted[0].path, 'artifact.txt');
  assert.equal(await readFile(extracted[0].destination, 'utf8'), 'exec artifact|script|code');
  const delivered = await execute({ action: 'finish' });
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
  assert.equal((f.manager as any).timer, undefined, 'finish clears the heartbeat timer');
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
    // Nineteen relay_* tools replace the old single relay tool; a call's
    // action (and, for run, kind) selects which one, and the rest of the
    // args are its own arguments (no action/kind field on the wire).
    const toolFor = ({ action, kind }: { action: string; kind?: string }) => `relay_${(kind ?? action).replace(/-/g, '_')}`;
    let named: { imageId: string } | undefined;
    const invoke = async (args: Record<string, unknown>) => {
      const { action, kind, ...rest } = args as { action: string; kind?: string; [key: string]: unknown };
      const result: any = await client.callTool({ name: toolFor({ action, kind }), arguments: rest });
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
    await invoke({ action: 'stage', nodePath: process.execPath, cuaDriver: f.driver });
    const result = await invoke({ action: 'run', reason, kind: 'exec', argv: [process.execPath, '-e', "require('fs').writeFileSync('artifact.txt','compiled package')"], step: { id: 'compiled', title: 'Compiled package', expected: 'Declared artifact written', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } });
    assert.equal(result.outcome.kind, 'completed');
    const image: any = await client.callTool({ name: 'relay_image', arguments: { target: { source: 'reference', imageId: named!.imageId } } });
    assert.equal(image.isError, false, image.content[0].text);
    assert.equal(image.content.find((c: any) => c.type === 'image').mimeType, 'image/png', 'relay_image shows the downloaded after-image');
    const status: any = await client.callTool({ name: 'relay_status', arguments: {} });
    const owned = JSON.parse(status.content[0].text);
    assert.equal(owned.staged, true); assert.equal(owned.active, true); assert.equal(owned.service, f.manager.vm.baseUrl);
    const delivered = await invoke({ action: 'finish' }); assert.equal(delivered.execution, 'passed'); assert.equal(delivered.deliveryVerified, true);
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
  await invoke({ action: 'stage', cuaDriver: f.driver, nodePath: process.execPath });
  const run = (id: string, code = 'console.log("fixture input")', snapshots: RunInput['snapshots'] = { afterIntervalMs: 0 }) => invoke({
    action: 'run', reason, kind: 'exec', argv: [process.execPath, '-e', code], step: operation(id).step, snapshots,
  } as RelayInput);
  const first = imageDetails(await run('source', `const fs=require('fs');fs.mkdirSync('consumer');fs.writeFileSync('consumer/screenshot.png',Buffer.from('${png}','base64'));fs.writeFileSync('consumer/result.txt','consumer output');`), 'pending');
  assert.equal(first.isError, false); assert.equal(first.result.outcome.kind, 'completed');
  const descriptor = first.imageDelivery.image;
  assert.equal(descriptor.source, 'display'); assert.equal(descriptor.phase, 'after');
  assert.equal(descriptor.executionId, first.result.executionId);
  // relay_image by display selector waits for the background download, then shows the image the run named.
  const shownFirst = imageDetails(await invoke({ action: 'image', target: { source: 'display', sessionId: descriptor.sessionId, executionId: descriptor.executionId, phase: 'after' } }), 'attached');
  assert.deepEqual(shownFirst.imageDelivery.image, descriptor);
  assert.deepEqual(await readFile(descriptor.originalPath), Buffer.from(png, 'base64'));
  const counters = async () => ({ receiver: f.service.receiverCalls,
    captures: (await readFile(join(f.root, 'captures.jsonl'), 'utf8')).trim().split('\n').length,
    acquire: f.service.requests.filter(r => r.path === '/acquire').length,
    exports: await readdir(join(acquired.output, 'extractions')).catch(() => []),
    requests: f.service.requests.length,
  });
  const before = await counters();
  const again = imageDetails(await invoke({ action: 'image', target: { source: 'reference', imageId: descriptor.imageId } }), 'attached');
  assert.deepEqual(again.imageDelivery.image, descriptor);
  assert.deepEqual(await counters(), before, 'local reference recovery must not perform guest input, capture, acquisition, transfer or export');
  const application = imageDetails(await invoke({ action: 'image', target: { source: 'application', name: 'consumer', path: 'screenshot.png' } }), 'attached');
  assert.equal(application.imageDelivery.image.source, 'application');
  assert.equal(application.imageDelivery.image.name, 'consumer');
  assert.deepEqual(await readFile(application.imageDelivery.image.originalPath), Buffer.from(png, 'base64'));
  assert.equal(f.service.receiverCalls, before.receiver);
  assert.equal((await counters()).captures, before.captures);
  assert.deepEqual((await counters()).exports, []);
  imageDetails(await invoke({ action: 'image', target: { source: 'display', sessionId: 'foreign-session', executionId: descriptor.executionId, phase: 'after' } }), 'unauthorized-reference');
  imageDetails(await invoke({ action: 'image', target: { source: 'reference', imageId: `image-${'0'.repeat(64)}` } }), 'unauthorized-reference');
  imageDetails(await invoke({ action: 'image', target: { source: 'application', name: 'consumer', path: '../escape.png' } }), 'unsafe-path');
  for (const phase of ['first', 'member', 'last'] as const) {
    const grouped = imageDetails(await run(`group-${phase}`, undefined, { group: { groupId: 'text-group', phase }, ...(phase === 'last' ? { afterIntervalMs: 0 } : {}) }), phase === 'last' ? 'pending' : 'not-requested');
    assert.equal(grouped.result.outcome.kind, 'completed');
    if (phase === 'last') { assert.equal(grouped.imageDelivery.image.groupId, 'text-group'); imageDetails(await invoke({ action: 'image', target: { source: 'reference', imageId: grouped.imageDelivery.image.imageId } }), 'attached'); }
  }
  // The step download fails its three archive pulls; it is not queued again, and relay_image then makes its own copy.
  f.service.archivePullFailures = 3;
  const pullsBefore = f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('.png')).length;
  const failedTransfer = imageDetails(await run('transfer-failure'), 'pending');
  assert.equal(failedTransfer.result.outcome.kind, 'completed');
  const recoveryBefore = await counters();
  const recovered = imageDetails(await invoke({ action: 'image', target: { source: 'reference', imageId: failedTransfer.imageDelivery.image.imageId } }), 'attached');
  assert.ok(f.service.archivePullFailures <= 0);
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('.png')).length - pullsBefore, 1, 'the retrieval\'s own copy');
  const record = await json(join(acquired.output, 'host/evidence-downloads', `${failedTransfer.result.executionId}.json`));
  assert.equal(record.status, 'failed'); assert.equal(record.failure, 'transfer-failed'); assert.equal(record.image.imageId, failedTransfer.imageDelivery.image.imageId);
  assert.deepEqual(recovered.imageDelivery.image, failedTransfer.imageDelivery.image);
  assert.equal((await counters()).receiver, recoveryBefore.receiver); assert.equal((await counters()).captures, recoveryBefore.captures);
  assert.equal((await counters()).acquire, recoveryBefore.acquire); assert.deepEqual((await counters()).exports, []);
  const failedExecution = imageDetails(await run('failed-execution', 'process.exit(9)'), 'pending');
  assert.equal(failedExecution.isError, true); assert.equal(failedExecution.result.outcome.exitStatus.code, 9);
  const delivered = (await invoke({ action: 'finish' })).details as any;
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
  const hostRoot = f.manager.status().output!;
  const result = await tool.execute('release', { action: 'release' }, signal, undefined, ctx);
  assert.deepEqual(result.details, { active: false });
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ active: false }, null, 2) }]);
  const events = await Promise.all((await readdir(join(hostRoot, 'host/events'))).map(path => json(join(hostRoot, 'host/events', path))));
  assert.equal(Object.hasOwn(events.find(event => event.kind === 'release'), 'because'), false);
  assert.equal(f.service.requests.find(request => request.path.endsWith('/release'))?.body.reason, 'released');
  assert.equal((await json(`${hostRoot}.lifecycle.json`)).released, true);
  await f.assertClean(); assert.equal(f.service.releaseCalls, 1);
  assert.equal((f.manager as any).timer, undefined, 'release clears the heartbeat timer');
});

test('single relay tool: unknown actions and cross-action fields reject before getter or HTTP dispatch', async t => {
  const f = await fixture(t); let getterCalls = 0;
  const tool = createRelayTool(() => { getterCalls++; return f.manager; });
  const invalid = [
    { action: 'unknown', reason },
    { action: 'relay_acquire', reason, task: 'manager-test', image: 'ubuntu2404', extractions: [] },
    { action: 'acquire', reason, task: 'manager-test', image: 'ubuntu2404', extractions: [], names: ['artifact'] },
    { action: 'stage', reason, argv: [process.execPath, '-e', 'process.exit(0)'] },
    { action: 'run', reason, kind: 'exec', argv: [process.execPath, '-e', 'process.exit(0)'], step: operation('invalid').step, snapshots: { afterIntervalMs: 0 }, code: 'process.exit(0)' },
    { action: 'extract', reason, names: [], image: 'ubuntu2404' },
    { action: 'finish', reason, names: [] },
    { action: 'release', reason, task: 'manager-test' },
    { action: 'acquire', because: reason, task: 'manager-test', image: 'ubuntu2404', extractions: [] },
  ];
  for (const args of invalid) {
    await assert.rejects(tool.execute('invalid', args as never, undefined, undefined, {} as ExtensionContext), /Invalid relay input/);
    assert.equal(getterCalls, 0, 'invalid input must not even obtain a manager');
    assert.deepEqual(f.service.requests, [], 'invalid input must not reach the fixture service');
  }
  assert.deepEqual(f.manager.status(), { active: false });
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
});

test('cancel after acquire dispatch retains returned identity until explicit release; pre-abort never allocates', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.service.acquireHook = async () => { controller.abort(new Error('cancel during allocation')); };
  await assert.rejects(f.manager.acquire(acquireInput(), controller.signal), /cancel during allocation/);
  await f.assertRetained([...f.service.leases.keys()][0]);
  assert.match(f.manager.status().lastError!, /cancel during allocation/);
  await f.stage();
  assert.equal((await f.manager.run(operation('after-cancel'))).outcome.kind, 'completed');
  await f.manager.release(); await f.assertClean();
  await assert.rejects(f.manager.acquire(acquireInput(), AbortSignal.abort(new Error('already cancelled'))), /already cancelled/);
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
});

test('stage transfer failure retains lease and corrected transfer stages the same VM', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); f.service.failPush = true;
  await assert.rejects(f.stage(), /fixture push failed/); await f.assertRetained(acquired.vm);
  assert.equal(f.manager.status().staged, false);
  f.service.failPush = false; await f.stage();
  assert.equal((await f.manager.run(operation('after-transfer-repair'))).outcome.kind, 'completed');
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

for (const [label, run, expected] of [
  ['nonzero', operation('nonzero', { argv: [process.execPath, '-e', 'process.exit(7)'] }), 'completed'],
  ['refused', operation('orphan', { snapshots: { group: { groupId: 'not-started', phase: 'member' } } }), 'refused'],
] as const) test(`${label} receiver outcome retains the VM for a new operation without replay`, { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage(); const hostRoot = f.manager.status().output!;
  const result = await f.manager.run(run);
  assert.equal(result.outcome.kind, expected, JSON.stringify(result)); assert.equal(f.service.receiverCalls, 1); await f.assertRetained();
  assert.equal(result.leaseReleased, false); assert.match(f.manager.status().lastError!, /Execution/);
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
  await (f.manager as any).heartbeat(); await (f.manager as any).queue;
  await f.assertRetained(acquired.vm); assert.match(f.manager.status().lastError!, /heartbeat lost/i);
  assert.equal(f.manager.status().guestState, 'unknown', 'unavailable reconciliation cannot claim guest health');
  assert.equal(f.manager.status().expiresAt, f.service.leases.get(acquired.vm!)!.ttl_expires_at);
  f.service.failHeartbeat = false; f.service.failGet = false; await (f.manager as any).heartbeat();
  assert.equal(f.manager.status().guestState, 'running');
  await f.stage(); assert.equal((await f.manager.run(operation('after-heartbeat'))).outcome.kind, 'completed');
  await f.manager.release(); await f.assertClean();
});

test('unconfirmed release retains durable lease and registry until explicit retry succeeds', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); f.service.releaseFailures = 3;
  await assert.rejects(f.manager.release(), /destruction unavailable/);
  assert.equal(f.service.releaseCalls, 3); assert.equal(f.service.leases.size, 1); assert.equal(f.manager.status().vm, acquired.vm);
  assert.equal((await json(join(f.manager.root, 'lease.json'))).lease.vm, acquired.vm);
  assert.notEqual(await readFile(f.registryPath, 'utf8'), registryText);
  await f.manager.release(); await f.assertClean(); assert.equal(f.service.releaseCalls, 4);
});

for (const ending of ['settle', 'cleanup'] as const) test(`${ending} pauses renewal without destroying ownership and is idempotent`, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  assert.equal(f.manager.status().active, true);
  if (ending === 'settle') { await f.manager.settle(); await f.manager.settle(); }
  else { await f.manager.cleanup('shutdown fixture'); await f.manager.cleanup('shutdown fixture'); }
  await f.assertRetained(acquired.vm); assert.equal(f.manager.status().active, false);
  assert.equal((f.manager as any).timer, undefined);
  assert.equal((await json(join(f.manager.root, 'lease.json'))).active, false);
  if (ending === 'cleanup') await assert.rejects(f.manager.acquire(acquireInput()), /shutting down/);
  else { await f.stage(); assert.equal(f.manager.status().active, true); }
  await f.manager.release(); await f.assertClean();
});

test('new manager restores durable ownership without allocation or destruction', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  await f.manager.cleanup('simulated shutdown');
  assert.equal(await readFile(join(f.manager.root, 'owner.lock'), 'utf8'), '', 'stable lock inode survives unlock');
  const recovered = new RelayManager(f.options);
  try {
    await recovered.initialize(); assert.equal(recovered.status().vm, acquired.vm);
    assert.equal(recovered.status().active, false); assert.equal(recovered.status().guestState, 'running');
    assert.equal(f.service.releaseCalls, 0);
    await assert.rejects(recovered.acquire(acquireInput()), /already owns a lease/);
    await recovered.stage({ cuaDriver: f.driver, nodePath: process.execPath });
    assert.equal((await recovered.run(operation('restored'))).outcome.kind, 'completed');
    assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
  } finally { await recovered.release(); await recovered.cleanup('recovery teardown'); await f.manager.initialize(); }
});

test('finish destruction failure and later recovery do not modify the sealed package', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  await f.manager.run(operation('sealed-result')); const hostRoot = f.manager.status().output!;
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
  const run = await f.manager.run(operation('before-interruption')); const hostRoot = f.manager.status().output!;
  const checkpoint = await json(join(f.manager.root, 'lease.json'));
  const receipt = await readFile(join(hostRoot, 'host/receipts', `${run.executionId}.json`), 'utf8');
  await f.manager.cleanup('prepare restart');
  const recovered = new RelayManager(f.options);
  try {
    await recovered.initialize(); assert.equal(recovered.status().vm, acquired.vm); assert.equal(recovered.status().staged, true);
    assert.equal((await json(join(recovered.root, 'lease.json'))).sessionId, checkpoint.sessionId);
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
    assert.equal(f.manager.status().staged, false);
    assert.equal(f.manager.status().previousEvidence?.length, 1);
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
    assert.equal(recovered.status().staged, !previousRecording);
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
    assert.equal(f.manager.status().output, acquired.output); assert.equal(f.manager.status().recordingResetPending, true);
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
  assert.equal(f.manager.status().previousEvidence?.length, 1); assert.notEqual(f.manager.status().output, acquired.output);
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

test('unknown/unavailable images and unsafe extraction declarations do not allocate; sibling acquire cannot own two leases', async t => {
  const f = await fixture(t);
  for (const image of ['unknown', 'missing']) await assert.rejects(f.manager.acquire(acquireInput({ image })), /Image unavailable/);
  for (const extractions of [[{ name: 'escape', path: '../escape' }], [{ name: 'bad/name', path: 'safe' }], [{ name: 'full-workspace', path: 'safe' }], [{ name: 'same', path: 'a' }, { name: 'same', path: 'b' }]]) await assert.rejects(f.manager.acquire(acquireInput({ extractions })));
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 0);
  const results = await Promise.allSettled([f.manager.acquire(acquireInput()), f.manager.acquire(acquireInput())]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(f.service.leases.size, 1);
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
    assert.equal(f.manager.status().staged, false, name);
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
  const script = (id: string, localPath: string) => operation(id, { kind: 'script', language: 'javascript', localPath });
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
    assert.deepEqual(f.manager.status(), { active: false }); assert.equal(await readFile(f.registryPath, 'utf8'), registryText);
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
});

test('lost acquire response reconciles by pre-recorded purpose without allocating twice', async t => {
  const f = await fixture(t); f.service.loseAcquireResponse = true;
  f.service.acquireHook = async () => {
    const intent = await json(join(f.manager.root, 'lease.json'));
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
  const retained = await json(join(f.manager.root, 'lease.json'));
  assert.equal(retained.acquisitionInFlight, true); assert.equal(retained.lease, undefined);
  assert.equal(f.service.leases.size, 1); assert.equal(f.service.releaseCalls, 0);
  assert.ok((await readFile(f.registryPath, 'utf8')).includes(retained.purpose));
  await assert.rejects(f.manager.acquire(acquireInput()), /already owns a lease/);
  f.service.hideLeases = false;
  await f.manager.release(); await f.assertClean();
  assert.equal(f.service.requests.filter(r => r.path === '/acquire').length, 1);
});

test('uncertain receiver identity retains original receipt and VM without replay', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const hostRoot = f.manager.status().output!; f.service.malformedReceiverResponse = true;
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
  const before = f.manager.status();
  const requests = f.service.requests.length;
  for (const because of ['', '  ', 'x'.repeat(4001), 42]) {
    await assert.rejects(f.manager.run(operation('invalid-reason', { because: because as string })), /reason must be nonblank/);
    assert.deepEqual(f.manager.status(), before);
    assert.equal(f.service.requests.length, requests);
  }
  assert.equal(f.service.receiverCalls, 0); assert.equal(f.service.releaseCalls, 0);
  await f.manager.release(); await f.assertClean();
});

test('a run without reason, step or interval derives its record and uses the default wait', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const result = await f.manager.run({ kind: 'exec', argv: [process.execPath, '-e', 'console.log("derived")'] });
  assert.equal(result.outcome.kind, 'completed');
  const request = await json(join(f.manager.status().output!, 'host/requests', `${result.executionId}.json`));
  assert.equal(request.step.id, 'exec-1'); assert.match(request.step.title, /^exec node -e /);
  assert.equal(request.step.expected, 'Exits with status 0'); assert.equal(request.step.inputMode, 'ordinary');
  assert.deepEqual(request.snapshots, { afterIntervalMs: 500 });
  assert.match(request.because, /^Relay exec node .*\(no reason given\)$/);
  assert.equal(result.imageDelivery.status, 'pending', 'snapshots are automatic');
  // A text group's last member without its own interval gets the default too; explicit values still win.
  const group = await f.manager.run(operation('group-first', { snapshots: { group: { groupId: 'g1', phase: 'first' } } }));
  assert.equal(group.outcome.kind, 'completed');
  const last = await f.manager.run(operation('group-last', { snapshots: { group: { groupId: 'g1', phase: 'last' } } }));
  assert.equal(last.outcome.kind, 'completed');
  assert.deepEqual((await json(join(f.manager.status().output!, 'host/requests', `${last.executionId}.json`))).snapshots, { group: { groupId: 'g1', phase: 'last' }, afterIntervalMs: 500 });
  await f.manager.release(); await f.assertClean();
});

test('failure evidence logging error retains ownership until explicit release', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); const hostRoot = f.manager.status().output!;
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

test('relay_run forwards unchanged tool calls through the receiver and the guest MCP host, with automatic evidence', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const call = (raw: unknown) => relayCall(f.manager, raw);
  const body = (text: string) => relayJson(text);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  // relay_tools: the fixture's real tools/list, pulled from the guest.
  const listed = await call({ action: 'tools', target: 'playwright' });
  assert.equal(listed.isError, false);
  assert.deepEqual(JSON.parse(listed.text).tools.map((tool: { name: string }) => tool.name), ['increment', 'echo', 'picture', 'fail', 'escalate', 'crash', 'slow', 'huge']);
  assert.deepEqual(JSON.parse((await call({ action: 'tools', target: 'playwright', tool: 'echo' })).text).tools[0].inputSchema.required, ['text']);
  // No reason, step or interval: the record is derived and the evidence is automatic.
  const first = await call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment', args: { by: 2 } });
  assert.equal(first.isError, false, first.text);
  assert.equal(first.imageDelivery?.status, 'pending'); assert.equal(first.image, undefined, 'the after-snapshot downloads in the background');
  assert.deepEqual(first.content, [{ type: 'text', text: first.content![0].type === 'text' ? first.content![0].text : '' }]);
  assert.match((first.content![0] as { text: string }).text, /^count=2 /, 'the tool\'s own text passes through');
  const result = body(first.text);
  assert.equal(result.relayOutcome, 'completed'); assert.equal(result.toolOutcome, 'completed');
  assert.deepEqual(result.step, { id: 'playwright.increment-1', title: 'playwright.increment', expected: 'playwright.increment returns without a tool error', inputMode: 'ordinary' });
  assert.deepEqual(result.snapshots, { afterIntervalMs: 300 });
  const request = await json(join(f.manager.status().output!, 'host/requests', `${result.executionId}.json`));
  assert.equal(request.because, 'Relay playwright.increment (no reason given)');
  assert.deepEqual(request.argv.slice(2, 7), ['call', join(acquired.guestRoot, 'mcp'), 'playwright', 'increment', '{"by":2}'], 'tool and args forwarded unchanged');
  // The same server process keeps its state: the session persists across calls.
  const second = await call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment', args: { by: 3 }, reason: 'Count again', expected: 'count=5', afterIntervalMs: 0 });
  assert.match((second.content![0] as { text: string }).text, /^count=5 /);
  assert.equal(body(second.text).step.expected, 'count=5'); assert.deepEqual(body(second.text).snapshots, { afterIntervalMs: 0 });
  // cua launches through the real `<cuaDriver> mcp` command; its image block is delivered inline too.
  const picture = await call({ action: 'run', kind: 'mcp', target: 'cua', tool: 'picture' });
  assert.equal(picture.isError, false, picture.text);
  assert.deepEqual(picture.content!.map(block => block.type), ['text', 'image']);
  const tool = body(picture.text);
  assert.equal(tool.toolImages[0].status, 'attached'); assert.equal(tool.toolImages[0].image.source, 'application');
  assert.deepEqual(tool.snapshots, { afterIntervalMs: 500 });
  // A mismatch is refused on the host: nothing reaches the receiver, the correct schema comes back.
  const receiverCalls = f.service.receiverCalls;
  const mismatch = await call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'echo', args: { text: 42 } });
  assert.equal(mismatch.isError, true);
  assert.equal(body(mismatch.text).sent, false); assert.deepEqual(body(mismatch.text).inputSchema.required, ['text']);
  assert.equal((await call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'nope' })).isError, true);
  assert.equal(f.service.receiverCalls, receiverCalls, 'refused before sending anything');
  // The target's isError: completed with a tool error; an error result; the VM is kept.
  const failed = await call({ action: 'run', kind: 'mcp', target: 'chrome-devtools', tool: 'fail' });
  assert.equal(failed.isError, true);
  assert.equal(body(failed.text).relayOutcome, 'completed-with-tool-error'); assert.equal(body(failed.text).outcome.exitStatus.code, 3);
  assert.equal((failed.content![0] as { text: string }).text, 'fixture tool error');
  assert.equal(failed.imageDelivery?.status, 'pending', 'a failed call is still bracketed by snapshots');
  await f.assertRetained(acquired.vm);
  assert.deepEqual((await f.mcpCalls()).map(entry => `${entry.server}.${entry.tool}`), ['playwright.increment', 'playwright.increment', 'cua.picture', 'chrome-devtools.fail']);
  // finish stops the host and brings the results home as the relay-run extraction.
  const output = f.manager.status().output!;
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true); assert.equal(delivered.execution, 'failed');
  const root = join(output, 'extractions', 'relay-run');
  const copy = join(root, (await readdir(root))[0]!);
  assert.ok((await readdir(join(copy, 'playwright'))).length >= 2);
  assert.ok((await readdir(join(copy, 'servers'))).includes('playwright.log'));
  await f.assertClean();
});

test('relay_run with a hold is delivered and waits; relay_gate go sends it, cancel refuses it with nothing sent', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const call = (raw: unknown) => relayCall(f.manager, raw);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  // Released while it waits in the guest: the call completes and says how it was decided.
  const held = call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment', args: { by: 2 }, hold: { id: 'h-go', timeoutMs: 20000 } });
  await until(() => f.service.receiverCalls === 1, 'the held run to reach the guest');
  assert.deepEqual(await f.mcpCalls(), [], 'nothing is sent while held');
  const gate = relayJson((await call({ action: 'gate', hold: 'h-go', decision: 'go' })).text);
  assert.deepEqual(gate, { hold: 'h-go', requested: 'go', decision: 'go', applied: true });
  const released = await held;
  assert.equal(released.isError, false, released.text);
  assert.match((released.content![0] as { text: string }).text, /^count=2 /);
  assert.equal(relayJson(released.text).hold.decision, 'go');
  // Cancelled: refused, with no MCP call, and the VM is not marked failed.
  const cancelled = call({ action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment', hold: { id: 'h-cancel' } });
  await until(() => f.service.receiverCalls === 2, 'the second held run to reach the guest');
  assert.equal(relayJson((await call({ action: 'gate', hold: 'h-cancel', decision: 'cancel' })).text).applied, true);
  const refused = await cancelled;
  assert.equal(refused.isError, true);
  const body = relayJson(refused.text);
  assert.equal(body.outcome.kind, 'refused'); assert.match(body.outcome.diagnostic, /not released \(cancel\); nothing was sent/);
  assert.equal(body.hold.decision, 'cancel');
  assert.equal(f.manager.status().lastError, undefined, 'a withheld call is not a failure of the VM');
  assert.deepEqual((await f.mcpCalls()).map(entry => entry.tool), ['increment']);
  // A decided hold answers from its receipt; a hold is named once; an unknown hold is an error.
  assert.deepEqual(relayJson((await call({ action: 'gate', hold: 'h-cancel', decision: 'go' })).text), { hold: 'h-cancel', requested: 'go', decision: 'cancel', applied: false });
  await assert.rejects(f.manager.run({ kind: 'mcp', target: 'playwright', tool: 'increment', hold: { id: 'h-go' } }), /already used/);
  await assert.rejects(call({ action: 'gate', hold: 'h-none', decision: 'go' }), /No relay_run in this session named hold h-none/);
  await f.assertRetained(acquired.vm);
  await f.manager.release(); await f.assertClean();
});

test('relay_run: a server crash mid-call is uncertain, keeps the VM and is never replayed', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const crashed = await relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'playwright', tool: 'crash' });
  assert.equal(crashed.isError, true);
  assert.equal(relayJson(crashed.text).outcome.kind, 'uncertain');
  assert.equal(f.service.receiverCalls, 1);
  await f.assertRetained(acquired.vm);
  const after = await relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment' });
  assert.match((after.content![0] as { text: string }).text, /^count=1 /, 'a fresh server; the crashed call was not replayed');
  assert.deepEqual((await f.mcpCalls()).map(entry => entry.tool), ['crash', 'increment']);
  await f.manager.release(); await f.assertClean();
});

test('relay_run stages pinned packages hash-checked and refuses a tarball that does not match its pin', { timeout: 60000 }, async t => {
  const source = await realpath(await mkdtemp(join(tmpdir(), 'relay-package-')));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(join(source, 'package'));
  await writeFile(join(source, 'package', 'package.json'), JSON.stringify({ name: 'fixture-mcp', version: '1.0.0' }));
  await writeFile(join(source, 'package', 'server.cjs'), `import(${JSON.stringify(mcpFixture)});`);
  execFileSync('tar', ['-czf', join(source, 'fixture.tgz'), '-C', source, 'package']);
  const bytes = await readFile(join(source, 'fixture.tgz'));
  const pin = { name: 'fixture-mcp', version: '1.0.0', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  let fetched = 0;
  const log = join(source, 'calls.jsonl');
  const f = await fixture(t, {
    targetPackages: { playwright: { entry: 'fixture-mcp/server.cjs', packages: [pin] }, 'chrome-devtools': { entry: '', packages: [{ ...pin, integrity: 'sha512-AAAA' }] } },
    tarballSource: async () => { fetched++; return bytes; },
    targetLaunches: context => ({ ...fixtureLaunches(log)(context), playwright: { command: context.node, args: [join(context.packagesRoot, 'node_modules', 'fixture-mcp', 'server.cjs'), 'playwright'], cwd: context.workspace, env: { FIXTURE_LOG: log } } }),
  });
  const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const ran = await relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment' });
  assert.equal(ran.isError, false, ran.text);
  assert.equal(await readFile(join(acquired.guestRoot, 'mcp/packages/node_modules/fixture-mcp/server.cjs'), 'utf8'), `import(${JSON.stringify(mcpFixture)});`);
  await relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment' });
  assert.equal(fetched, 1, 'fetched once, then served from the verified host cache');
  const receiverCalls = f.service.receiverCalls;
  await assert.rejects(relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'chrome-devtools', tool: 'increment' }), /does not match its pinned integrity/);
  assert.equal(f.service.receiverCalls, receiverCalls);
  await f.manager.release(); await f.assertClean();
});

test('probe scope=guest reports per-target availability without starting anything', async t => {
  const f = await fixture(t); await f.manager.acquire(acquireInput()); await f.stage();
  const facts = await f.manager.probe('guest') as any;
  assert.equal(facts.targets.cua.available, true); assert.deepEqual(facts.targets.cua.launch, [f.driver, 'mcp']);
  assert.equal(facts.targets.playwright.server.state, 'not-started');
  assert.deepEqual(facts.targets.playwright.pinned, ['@playwright/mcp@0.0.82', 'playwright@1.64.0-alpha-1789764292000', 'playwright-core@1.64.0-alpha-1789764292000']);
  assert.equal(f.service.receiverCalls, 0);
  await relayCall(f.manager, { action: 'run', kind: 'mcp', target: 'playwright', tool: 'increment' });
  const later = await f.manager.probe('guest') as any;
  assert.equal(later.targets.playwright.server.state, 'running');
  await f.manager.release(); await f.assertClean();
});

test('explicit release retains declared outputs already produced before a nonzero operation', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'failure-log', path: 'error.txt' }] })); await f.stage();
  await writeFile(join(acquired.workspace, 'error.txt'), 'original failure evidence');
  const result = await f.manager.run(operation('failure', { argv: [process.execPath, '-e', 'process.exit(1)'] }));
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
  const versions = await readdir(join(result.evidencePath, 'extractions', 'failure-log'));
  assert.equal(await readFile(join(result.evidencePath, 'extractions', 'failure-log', versions[0]), 'utf8'), 'original failure evidence');
  assert.equal((await verifyDeliveredPackage(result.evidencePath)).execution, 'failed');
});

test('late heartbeat from released enclosure cannot destroy its replacement', async t => {
  const f = await fixture(t), entered = deferred(), returnFailure = deferred();
  await f.manager.acquire(acquireInput());
  f.service.heartbeatHook = async () => { entered.resolve(); await returnFailure.promise; throw new Error('old VM gone'); };
  const heartbeat = (f.manager as any).heartbeat(); await entered.promise;
  await f.manager.release();
  const next = await f.manager.acquire(acquireInput());
  returnFailure.resolve(); await heartbeat;
  await (f.manager as any).queue;
  assert.equal(f.manager.status().vm, next.vm); assert.equal(f.service.leases.size, 1);
  await f.manager.release(); await f.assertClean();
});

test('pre-stage diagnostic records host-only results and repairs setup without allocating again', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  const tool = createRelayTool(() => f.manager);
  const args = (id: string, code: string, timeoutMs?: number): RelayInput => ({ action: 'run', reason, kind: 'exec', diagnostic: true, argv: [process.execPath, '-e', code], step: { ...operation(id).step, expected: 'Diagnostic command completes', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 }, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
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
  assert.equal(f.manager.status().staged, false);
  const records = await readdir(join(acquired.output!, 'host/diagnostics'));
  assert.equal(records.length, 4);
  const requests = await Promise.all(records.filter(p => p.endsWith('.request.json')).map(p => json(join(acquired.output!, 'host/diagnostics', p))));
  assert.deepEqual(requests.map(r => r.timeoutMs).sort((a, b) => a - b), [120000, 3600000]);
  assert.ok(requests.every(r => r.because === reason && r.diagnostic === true));
  assert.equal(f.service.requests.filter(r => r.path.endsWith('/push') || r.path.endsWith('/pull')).length, 0);
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/);
  await f.stage(); assert.equal((await f.manager.run(operation('after-setup-repair'))).outcome.kind, 'completed');
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

test('staged diagnostic uses the owned workspace without capture prerequisites and the next ordinary run captures', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const result = await f.manager.run(operation('staged-diagnostic', { diagnostic: true, argv: [process.execPath, '-e', 'console.log("diagnostic output")'] }));
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
  const state = f.manager.status(); assert.ok('previousEvidence' in state && state.previousEvidence?.length === 1);
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

test('guest probe checks executable readiness read-only before stage and after path repair', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  let before = f.service.requests.length;
  const initial = await f.manager.probe('guest');
  assert.ok('checks' in initial);
  assert.equal(initial.scope, 'guest'); assert.equal(initial.owned.vm, acquired.vm);
  assert.equal(initial.captureVerified, false); assert.equal(initial.browserVerified, false);
  assert.equal(initial.checks.find(c => c.name === 'node')?.ready, true);
  assert.equal(initial.checks.find(c => c.name === 'cuaDriver')?.ready, false);
  let commands = f.service.requests.slice(before).filter(r => r.path.endsWith('/exec'));
  assert.equal(commands.length, 3); assert.ok(commands.slice(0, 2).every(r => r.body.argv.at(-1) === '--version'));
  assert.equal(commands[2].body.argv[1], '-e', 'the browser executable check is a read-only access test');
  assert.equal(f.service.receiverCalls, 0); assert.equal(f.manager.status().staged, false);
  await f.stage(); before = f.service.requests.length;
  const staged = await f.manager.probe('guest');
  assert.ok('checks' in staged);
  assert.equal(staged.captureVerified, false); assert.equal(staged.browserVerified, false);
  assert.ok(staged.checks.every(c => c.ready), JSON.stringify(staged.checks));
  await assert.rejects(readFile(join(f.root, 'captures.jsonl')), /ENOENT/);
  commands = f.service.requests.slice(before).filter(r => r.path.endsWith('/exec'));
  assert.deepEqual(commands.slice(0, 2).map(r => r.body.argv), [[process.execPath, '--version'], [f.driver, '--version']]);
  assert.equal(commands.length, 3);
  await f.assertRetained(acquired.vm); await f.manager.release(); await f.assertClean();
});

test('staged executable path correction reattaches without replay or workspace replacement', async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput());
  await f.manager.stage({ nodePath: process.execPath, cuaDriver: join(f.root, 'missing-driver') });
  const failed = await f.manager.run(operation('bad-driver'));
  assert.notEqual(failed.outcome.kind, 'completed'); await f.assertRetained(acquired.vm);
  const sessionId = (await json(join(f.manager.root, 'lease.json'))).sessionId;
  await writeFile(join(acquired.workspace, 'keep.txt'), 'keep');
  const calls = f.service.receiverCalls;
  await f.stage(); assert.equal(f.service.receiverCalls, calls, 'path correction cannot replay failed input');
  assert.equal((await json(join(f.manager.root, 'lease.json'))).sessionId, sessionId);
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
  await f.assertRetained(acquired.vm); assert.ok(f.manager.status().lastError);
  assert.equal((await json(join(f.manager.root, 'lease.json'))).delivered, undefined);
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
  assert.equal((await json(join(f.manager.root, 'lease.json'))).delivered, undefined);
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
  assert.equal((await json(join(f.manager.root, 'lease.json'))).released, undefined);
  absent = true; await f.manager.release(); await f.assertClean();
});

test('R4: a lease that arrives after the caller cancelled relay_acquire is renewed and reported, not left without a heartbeat', async t => {
  const f = await fixture(t, { heartbeatMs: 20 }), controller = new AbortController();
  f.service.acquireHook = async () => { controller.abort(new Error('cancel during allocation')); };
  const failure = await f.manager.acquire(acquireInput(), controller.signal).then(() => assert.fail('a cancelled acquire is still an error'), (error: Error) => error);
  const vm = [...f.service.leases.keys()][0];
  await f.assertRetained(vm);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(f.manager.status().active, true, 'the owned lease is being renewed');
  assert.ok(f.service.heartbeatCount > 0, 'a retained lease is renewed rather than left to expire unnoticed');
  assert.match(failure.message, /cancel during allocation/);
  assert.match(failure.message, new RegExp(`${vm}.*retained`), 'the error names the VM that is now owned and retained');
  await f.manager.release(); await f.assertClean();
});

test('R5: finish records a declared output that was never produced as incomplete and still delivers and releases', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'missing', path: 'never-written.txt' }, { name: 'artifact', path: 'artifact.txt' }] }));
  await f.stage();
  await f.manager.run(operation('write-artifact', { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('artifact.txt', 'produced')"] }));
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
  f.service.execHook = async argv => { if (argv.includes('/* R6 hang */')) { entered.resolve(); await hold.promise; } };
  const running = f.manager.run(operation('hang', { diagnostic: true, argv: [process.execPath, '-e', '/* R6 hang */'], snapshots: undefined }), controller.signal);
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
  assert.equal((await json(join(f.manager.root, 'lease.json'))).delivered, undefined, 'nothing was delivered');
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
  await (f.manager as any).heartbeat(); await (f.manager as any).heartbeat();
  const seen = renewals(f.service);
  assert.deepEqual(seen.acquire, [0.25], 'acquire asks for the renewal window');
  assert.equal(seen.heartbeats.length, 2);
  for (const ttl of seen.heartbeats) assert.equal(ttl, 0.25, 'a heartbeat renews the window, not the 4-hour TTL');
  await f.manager.release(); await f.assertClean();
});

test('H6: renewal never reaches past the lease\'s own deadline and stops at its end', { timeout: 30000 }, async t => {
  const f = await fixture(t); // the 60 s fixture timer never fires here; the test drives each heartbeat
  await f.manager.acquire(acquireInput({ ttlHours: 1 }));
  assert.ok((f.manager as any).timer, 'renewal is running');
  const enclosure = (f.manager as any).enclosure;
  // Move the lease's start back so that 10 minutes of its 1-hour TTL remain.
  enclosure.startedAt = new Date(Date.now() - 50 * 60000).toISOString();
  await (f.manager as any).heartbeat();
  const last = renewals(f.service).heartbeats.at(-1)!;
  assert.ok(last > 9.9 / 60 && last <= 10 / 60, `the renewal ends at the lease's deadline (${last} h), not 15 minutes out`);
  // With 5 minutes left, less than vm-service's 0.1 h minimum renewal, the lease
  // already expires at its deadline, so renewal stops; so it does past the deadline.
  for (const minutesAgo of [55, 61]) {
    enclosure.startedAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
    const count = renewals(f.service).heartbeats.length;
    await (f.manager as any).heartbeat();
    assert.equal(renewals(f.service).heartbeats.length, count, `no renewal ${60 - minutesAgo} minutes before the lease's deadline`);
    assert.equal((f.manager as any).timer, undefined, 'the renewal timer stops');
    assert.equal(f.manager.status().active, false, 'status shows that renewal stopped');
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
  const lease = await json(join(f.manager.root, 'lease.json'));
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
  assert.equal(f.manager.status().downloads?.inFlight, 1);
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
  await until(() => f.manager.status().downloads?.failed === 1, 'the first download to fail');
  const pulls = archivePulls(f); await sleep(300);
  assert.deepEqual({ ...f.manager.status().downloads, pulls: archivePulls(f) }, { queued: 1, inFlight: 0, downloaded: 0, failed: 1, cancelled: 0, coalesced: 0, paused: true, state: 'open', pulls }, 'the worker is paused');
  const failed = await downloadRecord(acquired.output!, a.executionId!);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'transfer-failed');
  assert.ok(Date.parse(failed.endedAt) - Date.parse(failed.startedAt) >= 4000, 'the download waited 1 s, then 3 s, between its three archive pulls');
  await f.manager.extract([]);
  await until(() => f.manager.status().downloads?.downloaded === 1, 'the paused download to resume');
  assert.equal((await downloadRecord(acquired.output!, b.executionId!)).status, 'downloaded');
  assert.equal(f.manager.status().downloads?.paused, false);
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
  assert.equal(f.manager.status().downloads?.state, 'closing'); assert.equal(f.manager.status().downloads?.coalesced, 2);
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
  assert.notEqual(f.manager.status().output, acquired.output);
  hold = holdStepDownloads(f);
  const beforeRelease = await f.manager.run(operation('before-release'));
  const recording = f.manager.status().output!;
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

test('a step lists a result file it cannot find as missing, and an extraction takes a result file a step brought (AD-2, AD-4, AD-9)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput({ extractions: [{ name: 'result', path: 'relay-run/kept/result.json' }] })); await f.stage();
  const writes = (dir: string, write: boolean) => [process.execPath, '-e', `${write ? `require('fs').mkdirSync('relay-run/${dir}', { recursive: true }); require('fs').writeFileSync('relay-run/${dir}/result.json', '{"kept":true}');` : ''} console.log(JSON.stringify({ resultFile: '${dir}/result.json' }))`];
  const kept = await f.manager.run(operation('kept-result', { argv: writes('kept', true) }));
  const lost = await f.manager.run(operation('lost-result', { argv: writes('lost', false) }));
  await shown(f.manager, kept); await shown(f.manager, lost);
  const keptRecord = await downloadRecord(acquired.output!, kept.executionId!), lostRecord = await downloadRecord(acquired.output!, lost.executionId!);
  assert.equal(keptRecord.status, 'downloaded'); assert.ok(keptRecord.files.some((file: any) => file.path === 'workspace/relay-run/kept/result.json'));
  assert.equal(lostRecord.status, 'downloaded', 'a missing file does not fail the step');
  assert.deepEqual(lostRecord.missing, ['workspace/relay-run/lost/result.json']);
  const pulls = f.service.requests.filter(r => r.path.endsWith('/pull')).length;
  const delivered = await f.manager.finish();
  assert.equal(delivered.deliveryVerified, true);
  const events = await Promise.all((await readdir(join(acquired.output!, 'host/events'))).map(name => json(join(acquired.output!, 'host/events', name))));
  assert.deepEqual(events.find(event => event.kind === 'extraction-reused')?.details, { name: 'result', files: 1 });
  assert.ok(!f.service.requests.slice(pulls).some(r => r.path.endsWith('/pull') && r.body.remote_path.endsWith('result.json')), 'the result file is not pulled again');
  await f.assertClean();
});

test('a step file that changed after its download comes from the guest at finish (AD-6)', { timeout: 30000 }, async t => {
  const f = await fixture(t); const acquired = await f.manager.acquire(acquireInput()); await f.stage();
  const run = await f.manager.run(operation('changed-after-download')); await shown(f.manager, run);
  const guestRoot = (f.manager as any).current().guestRoot as string;
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
  try { await sibling.initialize(); assert.equal(sibling.status().vm, acquired.vm, 'the owner lock was released'); }
  finally { await sibling.cleanup('sibling check'); }
  hold.release(); await sleep(300);
  assert.equal(await exists(join(acquired.output!, 'host/evidence-downloads', `${run.executionId}.json`)), false, 'a closed queue writes nothing');
  assert.equal(await exists(run.imageDelivery.image!.originalPath!), false, 'an aborted download does not publish');
});
