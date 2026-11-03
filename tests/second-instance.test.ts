/**
 * The live scripts drive only a second instance that machine-service's
 * launcher started, never the installed one, and touch only its own
 * `si-<id>-` clones; its Tart store may be the operator's (DC-66,
 * DC-71 to DC-70, machine-service DC-246).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { admitRequest, confirmMark, confirmOwnedMachines, connectSecondInstance, flagValue, instanceTransport, MANIFEST, ownedBackend, ownedFolder, ownedVm, ownRegistry, readSecondInstance, secondInstance } from '../scripts/second-instance.mjs';
import type { VmBackend } from '../src/machine-service.js';
import { childEnvironment } from './isolation.js';

const run = promisify(execFile);

/** A launcher manifest as the crate writes it, its daemon's environment included. */
function launcherManifest(id: string, root: string, store: string, port = 16240, env: Record<string, string> = {}) {
  return { id, root, created_root: true, port, session_port: port + 1, bind: '127.0.0.1', tart_home: store, guest_link: 'ssh', durable: false, durable_cell: null, executable: '/x/machine-service',
    env: { PATH: '/usr/bin:/bin', HOME: '/h', TART_HOME: store, TART_NO_AUTO_PRUNE: '1', MACHINE_SERVICE_SECOND_INSTANCE: id, ...env } };
}

async function scratch(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-second-instance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), instance = join(root, 'instance'), store = join(root, 'store');
  await Promise.all([mkdir(join(home, '.tart'), { recursive: true }), mkdir(instance), mkdir(store)]);
  return { root, home, instance, store, manifest: launcherManifest('a1b2c3', instance, store) };
}

/** A listener that records what it hears and answers `answer(path)`. */
async function listener(t: TestContext, answer: (path: string) => unknown) {
  const heard: string[] = [];
  const server = createServer((req, res) => { heard.push(`${req.method} ${req.url}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answer(req.url ?? ''))); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return { heard, port: (server.address() as { port: number }).port };
}

test('a launcher manifest is the instance a live tool reaches, on a store of its own or the operator\'s own', async t => {
  const s = await scratch(t);
  assert.deepEqual(secondInstance(s.manifest, s.instance, s.home), { id: 'a1b2c3', root: s.instance, origin: 'http://127.0.0.1:16240', port: 16240, tartHome: s.store, operatorStore: false, vmPrefix: 'si-a1b2c3-', env: s.manifest.env });
  assert.equal(secondInstance({ ...s.manifest, bind: '::1' }, s.instance, s.home).origin, 'http://[::1]:16240');
  // Tart clones only within its own store, so the instance reads the operator's bases there (DC-246).
  const shared = secondInstance(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart')), s.instance, s.home);
  assert.equal(shared.operatorStore, true);
  assert.equal(shared.tartHome, join(s.home, '.tart'));
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(s.manifest));
  assert.equal((await readSecondInstance(s.instance, s.home)).id, 'a1b2c3');
});

test('the installed instance, a folder inside or around the operator\'s store and anything unmarked are refused', async t => {
  const s = await scratch(t);
  const env = s.manifest.env;
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ port: 6240 }, /port 6240 is the installed instance's/],
    [{ session_port: 6241 }, /port 6241 is the installed instance's/],
    [{ tart_home: join(s.home, '.tart', 'vms'), env: { ...env, TART_HOME: join(s.home, '.tart', 'vms') } }, /inside or around the operator's/],
    [{ tart_home: s.home, env: { ...env, TART_HOME: s.home } }, /inside or around the operator's/],
    [{ bind: '0.0.0.0' }, /on loopback/],
    [{ bind: '192.0.2.10' }, /on loopback/],
    [{ id: 'Not-An-Id' }, /names no second-instance id/],
    [{ id: undefined }, /names no second-instance id/],
    [{ root: join(s.root, 'other') }, /manifest of another root/],
    [{ tart_home: 'store' }, /names no Tart store/],
    [{ env: undefined }, /does not mark it second instance a1b2c3/],
    [{ env: { ...env, MACHINE_SERVICE_SECOND_INSTANCE: 'ffff' } }, /does not mark it second instance a1b2c3/],
    [{ env: { ...env, TART_HOME: join(s.home, '.tart') } }, /TART_HOME is not the manifest's Tart store/],
    [{ tart_home: join(s.home, '.tart') }, /TART_HOME is not the manifest's Tart store/],
    [{ env: { ...env, TART_NO_AUTO_PRUNE: undefined } }, /without TART_NO_AUTO_PRUNE=1/],
    [{ env: { ...env, TART_NO_AUTO_PRUNE: '0' } }, /without TART_NO_AUTO_PRUNE=1/],
  ];
  for (const [patch, refusal] of refused) assert.throws(() => secondInstance({ ...s.manifest, ...patch }, s.instance, s.home), refusal, JSON.stringify(patch));
  await assert.rejects(readSecondInstance(s.instance, s.home), /no second-instance\.json; start one with machine-service's second-instance launcher/);
  await assert.rejects(readSecondInstance('instance', s.home), /must be an absolute path/);
  const instance = secondInstance(s.manifest, s.instance, s.home);
  confirmMark(instance, { service: 'machine-service', second_instance: { id: 'a1b2c3' } });
  assert.throws(() => confirmMark(instance, { service: 'machine-service' }), /carries no second-instance mark/);
  assert.throws(() => confirmMark(instance, { second_instance: { id: 'ffff' } }), /marks instance ffff, not a1b2c3/);
  assert.equal(ownRegistry(join(s.root, 'evidence/relay'), s.home), join(s.root, 'evidence/relay'));
  assert.throws(() => ownRegistry(join(s.home, 'AGENTS.md'), s.home), /operator's/);
  assert.throws(() => ownRegistry(join(s.home, '.local/state/mcp-relay'), s.home), /operator's/);
  assert.equal(flagValue(['--run', '--instance', '/x'], '--instance'), '/x');
  assert.equal(flagValue(['--run'], '--instance'), undefined);
  assert.throws(() => flagValue(['--instance', '--tart', '/t'], '--instance'), /needs a value/);
  assert.throws(() => flagValue(['--instance', '/a', '--instance', '/b'], '--instance'), /given twice/);
});

test('a live tool sends only the instance\'s listings, one acquisition and calls on its own clones', async t => {
  const s = await scratch(t);
  const instance = secondInstance(s.manifest, s.instance, s.home);
  assert.equal(ownedVm(instance, 'si-a1b2c3-relay-x-1a2b3c'), 'si-a1b2c3-relay-x-1a2b3c');
  for (const vm of ['relay-x-1a2b3c', 'si-ffff-relay-x', 'si-a1b2c3-', 'pilot-ubuntu-base', 'xsi-a1b2c3-relay', undefined]) assert.throws(() => ownedVm(instance, vm), /not one of second instance a1b2c3's clones/, String(vm));
  const o = instance.origin;
  for (const [method, path] of [['GET', '/health'], ['GET', '/machines'], ['GET', '/images'], ['GET', '/applications'], ['GET', '/acquisition-capabilities'], ['POST', '/acquire'], ['GET', '/machines/si-a1b2c3-relay-x-1?lease_id=1']] as const) admitRequest(instance, method, o + path);
  for (const action of ['exec', 'push', 'pull', 'heartbeat', 'release', 'console/open', 'files']) admitRequest(instance, 'POST', `${o}/machines/si-a1b2c3-relay-x-1/${action}`);
  for (const [method, url, refusal] of [
    ['POST', `${o}/machines/foreign/release`, /not one of/],
    ['POST', `${o}/machines/${encodeURIComponent('si-ffff-x')}/exec`, /not one of/],
    ['POST', `${o}/machines/pilot-ubuntu-base/release`, /not one of/],
    ['POST', `${o}/gc`, /not a route a live tool sends/],
    ['DELETE', `${o}/machines`, /not a route/],
    ['POST', `${o}/applications`, /not a route/],
    ['GET', 'http://127.0.0.1:6240/health', /not second instance a1b2c3's origin/],
  ] as const) assert.throws(() => admitRequest(instance, method, url), refusal, `${method} ${url}`);

  // The transport refuses before sending, and fails an acquisition of a foreign VM.
  const sent: string[] = [];
  let leased = 'si-a1b2c3-relay-x-1';
  const transport = instanceTransport(instance, async (url, init) => { sent.push(`${init.method ?? 'GET'} ${url}`); return new Response(JSON.stringify({ vm: leased }), { status: 200 }); });
  await transport(`${o}/acquire`, { method: 'POST', body: '{}' });
  await assert.rejects(transport(`${o}/machines/relay-foreign/release`, { method: 'POST' }), /not one of/);
  leased = 'relay-x-1';
  await assert.rejects(transport(`${o}/acquire`, { method: 'POST', body: '{}' }), /VM relay-x-1 is not one of/);
  assert.deepEqual(sent, [`POST ${o}/acquire`, `POST ${o}/acquire`]);

  // The backend refuses a foreign VM on every call, the broker's included.
  const calls: string[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push(`${name} ${String(args[0])}`); return { vm: leased, rc: 0, output: '' }; };
  const base = { baseUrl: o, health: record('health'), list: record('list'), images: record('images'), applications: record('applications'), get: record('get'), acquire: record('acquire'), exec: record('exec'), push: record('push'), pull: record('pull'), heartbeat: record('heartbeat'), release: record('release'), useRelay: record('useRelay') } as unknown as VmBackend;
  const backend = ownedBackend(instance, base);
  await assert.rejects(backend.acquire({ image: 'ubuntu2404', purpose: 'relay-x' } as never), /VM relay-x-1 is not one of/);
  leased = 'si-a1b2c3-relay-x-1';
  assert.equal((await backend.acquire({ image: 'ubuntu2404', purpose: 'relay-x' } as never)).vm, leased);
  for (const method of ['exec', 'push', 'pull', 'heartbeat', 'release', 'get', 'useRelay'] as const) {
    await assert.rejects(async () => (backend[method] as any)('pilot-ubuntu-base', {}), /not one of/, method);
    await (backend[method] as any)(leased, {});
  }
  await backend.list();
  assert.equal(backend.baseUrl, o);
  assert.deepEqual(calls.filter(c => c.includes('pilot-ubuntu-base')), [], 'no foreign VM reached the backend');

  confirmOwnedMachines(instance, { machines: { 'si-a1b2c3-relay-x-1': {} } });
  assert.throws(() => confirmOwnedMachines(instance, { machines: { 'si-a1b2c3-relay-x-1': {}, 'relay-installed-1': {} } }), /relay-installed-1 is not one of/);

  // The folders the instance's catalog lies in are its own.
  const catalog = secondInstance(launcherManifest('a1b2c3', s.instance, s.store, 16240, { PILOT_REPO: join(s.instance, 'candidate/pilot'), PILOT_IMAGES_STATE_DIR: join(s.root, 'image-state') }), s.instance, s.home);
  assert.equal(ownedFolder(catalog, 'PILOT_REPO'), join(s.instance, 'candidate/pilot'));
  assert.throws(() => ownedFolder(catalog, 'PILOT_IMAGES_STATE_DIR'), /lies outside its root/);
  assert.throws(() => ownedFolder(instance, 'PILOT_REPO'), /names no PILOT_REPO/);
});

test('the mark is read once from /health before anything else', async t => {
  const s = await scratch(t);
  const marked = await listener(t, () => ({ second_instance: { id: 'a1b2c3' } }));
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart'), marked.port)));
  const { instance } = await connectSecondInstance(s.instance, s.home);
  assert.equal(instance.operatorStore, true);
  assert.deepEqual(marked.heard, ['GET /health']);
});

test('the lifecycle script refuses, before any evidence or lease, an instance that is not a marked second instance', { timeout: 120_000 }, async t => {
  const s = await scratch(t);
  // An unmarked instance: the installed one would answer like this.
  const unmarked = await listener(t, () => ({ service: 'machine-service' }));
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, s.store, unmarked.port)));
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const evidence = async () => (await readdir(resolve('test-evidence')).catch(() => [] as string[])).filter(name => /^(selected-image-lifecycle|real-base-chain)-/.test(name));
  const before = await evidence();
  const script = (name: string) => (...args: string[]) => run(process.execPath, [tsx, resolve(`scripts/${name}.ts`), '--run', ...args], { env: childEnvironment({ HOME: s.home }), timeout: 60_000 });
  const lifecycle = script('selected-image-lifecycle');
  const refusals: Array<[string[], RegExp]> = [
    [[], /--instance <root> is required/],
    [['--instance', s.instance], /--tart <absolute path> is required/],
    [['--instance', s.instance, '--tart', 'tart'], /--tart <absolute path> is required/],
    [['--instance', s.instance, '--tart', '/bin/sh'], /carries no second-instance mark/],
  ];
  for (const [args, refusal] of refusals) {
    await assert.rejects(lifecycle(...args), (error: any) => { assert.match(error.stderr, refusal, args.join(' ')); return true; });
  }
  // The operator's store, given by an unmarked instance, is refused at its mark.
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart'), unmarked.port)));
  await assert.rejects(lifecycle('--instance', s.instance, '--tart', '/bin/sh'), (error: any) => { assert.match(error.stderr, /carries no second-instance mark/); return true; });
  // A folder inside the operator's store is refused before any request.
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart/vms'), unmarked.port)));
  await assert.rejects(lifecycle('--instance', s.instance, '--tart', '/bin/sh'), (error: any) => { assert.match(error.stderr, /inside or around the operator's/); return true; });
  // The chain asks for its support driver before any instance is reached.
  await assert.rejects(script('real-base-chain')('--instance', s.instance, '--tart', '/bin/sh'), (error: any) => { assert.match(error.stderr, /--support-driver <path> is required/); return true; });
  // Only the /health reads of the mark; no lease, no evidence.
  assert.deepEqual(unmarked.heard, ['GET /health', 'GET /health']);
  assert.deepEqual(await evidence(), before);
  const source = await readFile(resolve('scripts/lifecycle.ts'), 'utf8');
  assert.match(source, /connectSecondInstance\(instanceRoot, home\);\s*check\(instance\);[\s\S]*await mkdir\(join\(root, 'audit'\)/, 'the mark and the script\'s checks come before any evidence is made');
  assert.doesNotMatch(await readFile(resolve('scripts/real-base-chain.ts'), 'utf8'), /6240|replace\(|generated-lifecycle/, 'the chain neither rewrites the lifecycle nor reaches the installed instance');
});

test('live-check refuses, before the server starts, an instance that is unmarked or lists a VM it did not make', { timeout: 120_000 }, async t => {
  const s = await scratch(t);
  const steps = join(s.root, 'steps.json'), out = join(s.root, 'out');
  await writeFile(steps, '[]');
  const liveCheck = (...args: string[]) => run(process.execPath, [resolve('scripts/live-check.mjs'), ...args], { env: childEnvironment({ HOME: s.home }), timeout: 60_000 });
  const refused = async (args: string[], refusal: RegExp) => assert.rejects(liveCheck(...args), (error: any) => { assert.equal(error.code, 2); assert.match(error.stderr, refusal, args.join(' ')); return true; });
  await refused([steps, out], /usage: node scripts\/live-check\.mjs --instance <root> --tart <path>/);
  await refused(['--environment', join(s.root, 'profile.json'), steps, out], /usage/);
  await refused(['--instance', s.instance, '--tart', 'tart', steps, out], /usage/);
  await refused(['--instance', s.instance, '--tart', '/bin/sh', steps, out], /no second-instance\.json/);
  const unmarked = await listener(t, () => ({ service: 'machine-service' }));
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart'), unmarked.port)));
  await refused(['--instance', s.instance, '--tart', '/bin/sh', steps, out], /carries no second-instance mark/);
  assert.deepEqual(unmarked.heard, ['GET /health']);
  const foreign = await listener(t, path => path === '/health' ? { second_instance: { id: 'a1b2c3' } } : { machines: { 'si-a1b2c3-relay-x-1': {}, 'relay-installed-1': {} } });
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(launcherManifest('a1b2c3', s.instance, join(s.home, '.tart'), foreign.port)));
  await refused(['--instance', s.instance, '--tart', '/bin/sh', steps, out], /relay-installed-1 is not one of second instance a1b2c3's clones/);
  assert.deepEqual(foreign.heard, ['GET /health', 'GET /machines']);
  await assert.rejects(readdir(out), { code: 'ENOENT' }, 'nothing was made');
});
