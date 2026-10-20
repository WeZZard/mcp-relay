import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RelayManager, type ManagerOptions } from '../src/manager.js';
import { Registry } from '../src/registry.js';
import { type VmBackend, type VmLease } from '../src/machine-service.js';
import { consoleStatus, acquisitionCapabilities } from '../src/console.js';
import { validateRelayInput } from '../src/schema.js';

const wire = JSON.parse(await readFile(new URL('./fixtures/console-reports.json', import.meta.url), 'utf8'));
const capabilities = structuredClone(wire.capabilities);
capabilities.options.vnc.backends.macos.available = false;
capabilities.options.vnc.backends.macos.status = 'unavailable';
const opening = { console_id: 'console-1', attempt_id: 'watch-1', userRequested: true as const, reason: 'The user requested viewing', expected: 'A viewer opens on the service host' };
async function fixture(t: test.TestContext, kind: 'linux' | 'macos' = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'relay-console-'));
  let lease: VmLease | undefined;
  let observation: Record<string, unknown> = structuredClone(wire.reports[`${kind}_ready`]);
  const calls: string[] = [], acquisitions: unknown[] = [];
  let loseOpen = false;
  const vm: VmBackend = {
    baseUrl: 'http://localhost:6240',
    health: async () => ({ ok: true, service: 'machine-service' }),
    images: async () => ({ images: { linux: { kind: 'linux', base_available: true }, macos: { kind: 'macos', base_available: true } } } as any),
    get: async () => { calls.push('get'); return { ...lease!, actually_running: true, ttl_hours_remaining: 1 }; },
    list: async () => ({ machines: lease ? { [lease.vm]: lease } : {} } as any),
    acquire: async body => { calls.push('acquire'); acquisitions.push(body); lease = { vm: 'vm-1', lease_id: 'lease-1', purpose: body.purpose, image: body.image!, image_kind: kind, state: 'running', ttl_expires_at: Date.now() / 1000 + 3600, ...(body.vnc ? { console: consoleStatus(observation) } : {}) } as VmLease; return lease; },
    acquisitionCapabilities: async () => { calls.push('capabilities'); return capabilities; },
    consoleResolve: async (_vm, body) => { calls.push('resolve'); assert.deepEqual(body, { lease_id: 'lease-1' }); return observation; },
    consoleOpen: async (_vm, body) => { calls.push('open'); observation = structuredClone(wire.reports[`${kind}_launched`]); observation.attempt = { ...(observation.attempt as object), attempt_id: body.attempt_id }; if (loseOpen) throw Error('password=secret'); return observation; },
    consoleCancel: async (_vm, body) => { calls.push('cancel'); observation = structuredClone(wire.reports[`${kind}_cancelled`]); observation.attempt = { ...(observation.attempt as object), attempt_id: body.attempt_id }; return observation; },
    release: async () => { calls.push('release'); lease = undefined; return { vm: 'vm-1', released: true, reason: 'test' }; },
    heartbeat: async () => ({ ...lease!, ttl_hours_remaining: 1 }),
    exec: async () => assert.fail('guest execution'), push: async () => assert.fail('push'), pull: async () => assert.fail('pull'), applications: async () => assert.fail('applications'),
  };
  const options: ManagerOptions = { sessionId: 'test', project: root, stateRoot: root, registry: new Registry({ managedRoot: root }), vm, verifyDestroyed: async () => !lease };
  const managers = [new RelayManager(options)];
  t.after(async () => { for (const manager of managers) await manager.cleanup('test'); await rm(root, { recursive: true, force: true }); });
  return { manager: managers[0], options, managers, calls, acquisitions, vm, get lease() { return lease!; }, setObservation: (v: Record<string, unknown>) => { observation = { ...observation, ...v }; }, lose: () => { loseOpen = true; } };
}

test('closed console schemas preserve legacy acquisition and reject hidden command/URL/snapshot inputs', () => {
  for (const vnc of [undefined, false, true]) validateRelayInput({ action: 'acquire', task: 'test', image: 'linux', extractions: [], ...(vnc === undefined ? {} : { vnc }) });
  validateRelayInput({ action: 'console-open', guest: 'test-1', ...opening });
  for (const patch of [{ userRequested: false }, { reason: '' }, { expected: ' ' }, { snapshots: { afterIntervalMs: 0 } }, { url: 'vnc://secret' }, { vm: 'foreign' }, { attempt_id: '../x' }]) assert.throws(() => validateRelayInput({ action: 'console-open', guest: 'test-1', ...opening, ...patch }));
  assert.throws(() => validateRelayInput({ action: 'console-open', ...opening }), 'a console call names its guest (DC-20)');
  for (const action of ['acquisition-capabilities', 'console-resolve', 'console-cancel']) assert.throws(() => validateRelayInput({ action, reason: 'not allowed' }));
});

test('capabilities are read-only and versioned, preserve independent unavailable platforms', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.acquisitionCapabilities()).options.vnc.backends.macos.status, 'unavailable');
  assert.deepEqual(f.calls, ['capabilities']);
  await assert.rejects(readFile(join(f.manager.root, 'lease.json')), /ENOENT/);
  assert.throws(() => acquisitionCapabilities({ ...capabilities, schemaVersion: 2 }));
  await assert.rejects(f.manager.acquire({ task: 'test', image: 'macos', extractions: [], vnc: true }), /unavailable/);
  assert.equal(f.calls.includes('acquire'), false);
});

test('explicit open and cancel preserve owned VM and separate observations, never auto-open', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  assert.equal((f.acquisitions[0] as any).vnc, true);
  assert.equal(f.calls.includes('open'), false);
  const status = await f.manager.consoleResolve();
  assert.equal(status.authentication, 'unverified'); assert.equal(status.pixels, 'unverified');
  const opened = await f.manager.consoleOpen(opening);
  assert.equal(opened.status, 'ready'); assert.equal(opened.attempt?.status, 'launched');
  assert.equal(opened.attempt?.transport_connected, true); assert.equal(opened.authentication, 'unverified'); assert.equal(opened.pixels, 'unverified'); assert.equal(opened.human_confirmation, 'unverified'); assert.equal(opened.screenshotEvidence, false);
  await f.manager.consoleOpen(opening);
  assert.equal(f.calls.filter(c => c === 'open').length, 1);
  await f.manager.consoleCancel(opening);
  assert.equal(f.manager.guestStatus().vm, 'vm-1'); assert.equal(f.calls.includes('release'), false);
  await f.manager.consoleOpen({ ...opening, attempt_id: 'watch-2' });
  assert.equal(f.calls.filter(c => c === 'open').length, 2);
  await f.manager.consoleCancel({ ...opening, attempt_id: 'watch-2' });
  await assert.rejects(f.manager.consoleOpen(opening), /already used/);
});

test('uncertain opening survives restoration without replay; cancellation recovers it', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  f.lose();
  await assert.rejects(f.manager.consoleOpen(opening), error => { assert.doesNotMatch(String(error), /password|secret/); return /unknown/.test(String(error)); });
  await f.manager.cleanup('restart');
  const restored = new RelayManager(f.options); f.managers.push(restored); await restored.initialize();
  assert.equal(f.calls.filter(c => c === 'open').length, 1);
  await restored.consoleOpen(opening);
  await assert.rejects(restored.consoleOpen({ ...opening, attempt_id: 'watch-2' }), /active or uncertain/);
  assert.equal(f.calls.filter(c => c === 'open').length, 1);
  await restored.consoleCancel(opening);
  assert.equal(restored.guestStatus().vm, 'vm-1');
});

test('stale console, replaced lease, expiry and remote-viewer responses refuse opening', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  await assert.rejects(f.manager.consoleOpen({ ...opening, console_id: 'foreign' }), /identity mismatch/);
  f.setObservation({ viewer_location: 'client-host' });
  await assert.rejects(f.manager.consoleOpen(opening), /service host/);
  f.setObservation({ viewer_location: 'service-host', lease_id: 'foreign' });
  await assert.rejects(f.manager.consoleOpen(opening), /identity mismatch/);
  f.setObservation({ lease_id: 'lease-1' });
  f.lease.ttl_expires_at = 1;
  await assert.rejects(f.manager.consoleOpen(opening), /expired/);
  assert.equal(f.calls.includes('open'), false);
});

test('ordinary acquisition omits vnc and works with old backends; unsupported discovery is explicit', async t => {
  const f = await fixture(t); delete f.vm.acquisitionCapabilities;
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [] });
  assert.equal(Object.hasOwn(f.acquisitions[0] as object, 'vnc'), false);
  await assert.rejects(f.manager.acquisitionCapabilities(), /lacks acquisition-capabilities/);
  assert.equal(f.calls.includes('resolve'), false);
  await assert.rejects(f.manager.consoleOpen(opening), /automatic VNC retrofit is forbidden/);
  assert.equal(f.calls.includes('open'), false);
});

test('restoring under a different environment refuses before backend or viewer calls', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  await f.manager.cleanup('restart');
  const count = f.calls.length;
  const other = new RelayManager({ ...f.options, tartHome: join(f.options.project, 'other-store') });
  await assert.rejects(other.initialize(), /different or unknown VM environment/);
  assert.equal(f.calls.length, count);
});

test('immutable lease replacement refuses console dispatch and leaves ownership retained', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  f.vm.get = async () => ({ ...f.lease, lease_id: 'replacement', actually_running: true, ttl_hours_remaining: 1 });
  await assert.rejects(f.manager.consoleOpen(opening), /Lease ownership identity mismatch/);
  assert.equal(f.manager.guestStatus().lease_id, 'lease-1');
  assert.equal(f.calls.includes('open'), false);
});

test('explicit false preserves the old path and a legacy lease cannot open', async t => {
  const f = await fixture(t); delete f.vm.acquisitionCapabilities;
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: false });
  assert.equal((f.acquisitions[0] as any).vnc, false);
  delete f.lease.lease_id;
  await assert.rejects(f.manager.consoleResolve(), /Legacy lease/);
  assert.equal(f.calls.includes('resolve'), false);
});

test('cancel before open records a terminal attempt without releasing or replaying', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  await f.manager.consoleCancel(opening);
  await f.manager.consoleOpen(opening);
  assert.equal(f.calls.includes('open'), false);
  assert.equal(f.calls.includes('release'), false);
  assert.equal(f.manager.guestStatus().consoleAttempt?.status, 'cancelled');
});

// The generator imports the backend's report methods from a vm-service checkout
// beside this repository. That Python implementation was replaced by the Rust
// port, so it now only exists in a historical checkout: point
// VM_SERVICE_PYTHON_BACKEND at one to re-run the generator. The checked-in
// fixture keeps its recorded source hash.
const backendReports = process.env.VM_SERVICE_PYTHON_BACKEND ?? resolve('../vm-service/bin/console_sessions.py');
test('checked-in fixtures match the backend report generator', { skip: !existsSync(backendReports) && `no backend at ${backendReports}; set VM_SERVICE_PYTHON_BACKEND to a historical vm-service checkout` }, () => {
  const generated = JSON.parse(execFileSync('python3', ['-B', new URL('./fixtures/generate-console-reports.py', import.meta.url).pathname], { encoding: 'utf8' }));
  assert.deepEqual(generated.reports, wire.reports);
  assert.deepEqual(generated.capabilities, wire.capabilities);
});

test('checked-in fixtures preserve every report observation through the console status allowlist', () => {
  for (const report of Object.values(wire.reports)) assert.deepEqual(consoleStatus(report), report);
  assert.throws(() => consoleStatus({ ...wire.reports.linux_ready, schemaVersion: 2 }), /schema/);
});

test('macOS limitations survive acquisition, resolve, open, duplicate open, cancellation and inspection', async t => {
  const f = await fixture(t, 'macos');
  const acquired = await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  const check = (v: ReturnType<typeof consoleStatus> | undefined) => {
    assert.ok(v); assert.equal(v.authentication_mechanism, 'human-guest-account-prompt');
    assert.equal(v.authentication, 'unverified'); assert.equal(v.session_binding, 'viewer-selection-unverified');
    assert.equal(v.server_enforced_view_only, false); assert.equal(v.pixels, 'unverified'); assert.equal(v.human_confirmation, 'unverified');
  };
  check(acquired.console); check(await f.manager.consoleResolve());
  const opened = await f.manager.consoleOpen(opening); check(opened);
  assert.equal(opened.attempt?.authentication, 'required'); assert.equal(opened.attempt?.transport_connected, true);
  const duplicate = await f.manager.consoleOpen(opening); check(duplicate);
  assert.equal(duplicate.attempt?.authentication, 'required');
  check(await f.manager.consoleCancel(opening)); check(f.manager.guestStatus().console);
  const discovered = (await f.manager.acquisitionCapabilities()).options.vnc.backends.macos;
  assert.equal(discovered.server_enforced_view_only, false); assert.equal(discovered.session_binding, 'viewer-selection-unverified');
});

test('nested terminal attempt permits a new explicit request while ready console alone does not', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  await f.manager.consoleOpen(opening);
  await assert.rejects(f.manager.consoleOpen({ ...opening, attempt_id: 'watch-2' }), /active or uncertain/);
  f.setObservation(wire.reports.linux_closed);
  await f.manager.consoleOpen({ ...opening, attempt_id: 'watch-2' });
  assert.equal(f.calls.filter(v => v === 'open').length, 2);
});

test('restart reports revoked acquisition console and never replays or opens another attempt', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  await f.manager.consoleOpen(opening); await f.manager.cleanup('restart');
  f.lease.console = consoleStatus(wire.reports.linux_revoked); f.setObservation(wire.reports.linux_revoked);
  const restored = new RelayManager(f.options); f.managers.push(restored); await restored.initialize();
  assert.equal(restored.guestStatus().console?.status, 'revoked');
  await assert.rejects(restored.consoleOpen({ ...opening, attempt_id: 'watch-2' }), /revoked/);
  assert.equal(f.calls.filter(v => v === 'open').length, 1);
});

test('controller loss cannot leave a ready observation or cause automatic recovery', async t => {
  const f = await fixture(t);
  await f.manager.acquire({ task: 'test', image: 'linux', extractions: [], vnc: true });
  f.vm.consoleResolve = async () => { throw new Error('Console unavailable after restart'); };
  await assert.rejects(f.manager.consoleOpen(opening), /restart/);
  assert.equal(f.manager.guestStatus().console?.status, 'unknown'); assert.equal(f.calls.includes('open'), false);
});

test('console projection discards endpoints, secrets and unrecognized nested observations', () => {
  const safe = consoleStatus({ ...wire.reports.linux_ready, password: 'SECRET', url: 'vnc://SECRET', port: 5900, authentication: { secret: 'SECRET' }, pixels: null });
  assert.doesNotMatch(JSON.stringify(safe), /SECRET|5900/);
  assert.equal(safe.authentication, 'unknown'); assert.equal(safe.pixels, 'unknown');
});
