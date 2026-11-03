import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayManager, type ManagerOptions } from '../src/manager.js';
import { MachineServiceError, type VmBackend, type VmLease } from '../src/machine-service.js';
import { Registry } from '../src/registry.js';
import { relayCall } from '../src/surface.js';
import type { Advertised } from '../src/mdns.js';

/**
 * The relay's questions and image acquisitions across instances
 * (machine-service FD-7; docs/instances.md; DC-7x-FED-1..6). A client Mac
 * whose own instance offers nothing, two VM hosts that offer Xcode in
 * different generations, and a stopped one, all found through the injected
 * Bonjour seam (DC-67): no test reaches a real network.
 */

const registryText = '## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n\n## End\n';
const capabilities = { schemaVersion: 1, options: { vnc: { default: false, backends: { linux: { available: false }, macos: { available: false } } } } };
const xcode = (version: string) => ({ id: 'bundle:com.apple.dt.Xcode', name: 'Xcode', aliases: [], version });
type Images = Record<string, { kind: 'macos' | 'linux'; base_available: boolean; concurrency: { running: number; limit: number | null; acquirable: boolean } }>;

/** An in-memory machine-service instance at `origin`. */
function instance(origin: string, machine_id: string, catalog: Array<{ image: string; version: string }>, options: { name?: string; generation?: number; refuse?: boolean; acquirable?: boolean } = {}) {
  const leases = new Map<string, VmLease>();
  const calls: string[] = [];
  const state = { name: options.name ?? 'unnamed', refuse: options.refuse ?? false };
  const images: Images = Object.fromEntries(catalog.map(({ image }) => [image, { kind: 'macos', base_available: true, concurrency: { running: 0, limit: 2, acquirable: options.acquirable ?? true } }]));
  const backend: VmBackend = {
    baseUrl: origin,
    health: async () => { calls.push('health'); return { ok: true, service: 'machine-service', instance: state.name, machine_id }; },
    list: async () => ({ machines: Object.fromEntries([...leases].map(([vm, lease]) => [vm, { ...lease, ttl_hours_remaining: 1, actually_running: true }])), limits: { max_macos_running: 2, grace_hours: 1 }, pilot_repo: '', port: 6240 }),
    images: async () => { calls.push('images'); return { images, capacity: { macos_running: 0, macos_limit: 2 }, catalog: { status: 'current', generation: options.generation ?? 1 } } as any; },
    applications: async () => { calls.push('applications'); return { schemaVersion: 1, images: catalog.map(({ image, version }) => ({ image, os: 'macos', architecture: 'arm64', applications: [xcode(version)] })) }; },
    acquisitionCapabilities: async () => { calls.push('acquisition-capabilities'); return capabilities; },
    get: async vm => { const lease = leases.get(vm); if (!lease) throw new MachineServiceError(`machine-service /machines/${vm}: HTTP 404`, 404); return { ...lease, ttl_hours_remaining: 1, actually_running: true }; },
    acquire: async body => {
      calls.push(`acquire ${body.image}`);
      if (state.refuse) throw Object.assign(new MachineServiceError('machine-service /acquire: HTTP 409: macOS VM limit reached (2/2)', 409, JSON.stringify({ error: 'macOS VM limit reached (2/2)' })), { capacity: true });
      const lease: VmLease = { vm: `pilot-${body.purpose}`, purpose: body.purpose, image: body.image!, image_kind: 'macos', env: 'none', state: 'running', machine_id, lease_id: `lease-${randomUUID()}`, created_at: 1, ttl_expires_at: Date.now() / 1000 + 3600, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null };
      leases.set(lease.vm, lease); return lease;
    },
    heartbeat: async vm => { calls.push(`heartbeat ${vm}`); return { ...leases.get(vm)!, ttl_hours_remaining: 1 }; },
    release: async vm => { calls.push(`release ${vm}`); leases.delete(vm); return { released: true, reason: 'released' }; },
    exec: async () => { throw new Error('unused'); }, push: async () => { throw new Error('unused'); }, pull: async () => { throw new Error('unused'); },
  };
  return { backend, calls, leases, state };
}

async function lab(t: TestContext, options: { refuseA?: boolean; aAcquirable?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-federation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, 'AGENTS.md'); await writeFile(registryPath, registryText);
  const laptop = instance('http://127.0.0.1:7000', 'id-laptop', [], { name: 'laptop' });
  const macA = instance('http://127.0.0.1:7001', 'id-mac-a', [{ image: 'macos26', version: '26.6' }, { image: 'macos27', version: '27.2' }], { name: 'mac-a', generation: 7, refuse: options.refuseA, acquirable: options.aAcquirable });
  // mac-b has not synced macos27's latest line: its Xcode differs (FD-7).
  const macB = instance('http://127.0.0.1:7002', 'id-mac-b', [{ image: 'macos26', version: '26.6' }, { image: 'macos27', version: '27.1' }], { name: 'mac-b', generation: 6 });
  const backends = new Map([macA, macB].map(fake => [fake.backend.baseUrl, fake.backend]));
  const advertised = (name: string, machine_id: string, port: number): Advertised => ({ name, instance: name, machine_id, host: `${name}.local`, address: '127.0.0.1', port, txt: { instance: name, machine_id } });
  const browse = async () => [advertised('laptop', 'id-laptop', 7000), advertised('mac-a', 'id-mac-a', 7001), advertised('mac-b', 'id-mac-b', 7002), advertised('mac-c', 'id-mac-c', 7003)];
  const durableBackend = (origin: string): VmBackend => backends.get(origin) ?? ({ baseUrl: origin, health: async () => { throw new MachineServiceError(`machine-service /health: request failed: connect ECONNREFUSED ${origin}`); } } as unknown as VmBackend);
  const sessionId = randomUUID();
  const make = (patch: Partial<ManagerOptions> = {}) => new RelayManager({ sessionId, project: root, stateRoot: join(root, 'state'), tartHome: join(root, 'tart'), tartPath: join(root, 'no-tart'), outputRoot: join(root, 'packages'),
    registry: new Registry(registryPath), vm: laptop.backend, discovery: 'bonjour', bonjourBrowse: browse, durableBackend, secondLookMs: 0, localTart: true, capacityWaitMs: 0, heartbeatMs: 60000, ...patch } as ManagerOptions);
  const manager = make();
  t.after(() => manager.cleanup('test teardown').catch(() => {}));
  return { root, manager, make, laptop, macA, macB, backends, registryPath };
}

test('relay_search reports every instance: who offers each installation, each catalog generation, the unreachable one (DC-7x-FED-3)', async t => {
  const f = await lab(t);
  const result = await f.manager.search({ name: 'Xcode', os: 'macos' });
  assert.deepEqual(result.instances.map(i => [i.instance, i.local, i.reachable, i.generation ?? null]), [['laptop', true, true, 1], ['mac-a', false, true, 7], ['mac-b', false, true, 6], ['mac-c', false, false, null]]);
  assert.match(result.instances[3]!.error!, /ECONNREFUSED/);
  assert.equal(result.applications.length, 1);
  const installations = result.applications[0]!.installations.map(i => [i.image, i.version, i.instances.map(o => `${o.instance}@${o.generation}`)]);
  assert.deepEqual(installations, [
    ['macos26', '26.6', ['mac-a@7', 'mac-b@6']],
    ['macos27', '27.1', ['mac-b@6']],
    ['macos27', '27.2', ['mac-a@7']],
  ]);
  assert.equal(result.applications[0]!.installations[0]!.instances[0]!.machine_id, 'id-mac-a');
  assert.equal(result.truncated, false);
  // `instance` narrows to one; a machine_id names it too.
  const one = await f.manager.search({ name: 'Xcode', instance: 'id-mac-b' });
  assert.deepEqual(one.instances.map(i => i.instance), ['mac-b']);
  assert.deepEqual(one.applications[0]!.installations.map(i => i.version), ['26.6', '27.1']);
  await assert.rejects(f.manager.search({ name: 'Xcode', instance: 'nowhere' }), /No machine-service instance is named "nowhere"; the instances are laptop .*mac-c \(id-mac-c, unreachable\)/);
  // Through the tool: the same answer, and `instance` is in its schema.
  const called = await relayCall(f.manager, { action: 'search', name: 'Xcode', instance: 'mac-a' });
  assert.equal(called.isError, false);
  assert.deepEqual(JSON.parse(called.text).instances.map((i: any) => i.instance), ['mac-a']);
});

test('a search with no catalog anywhere is an error, never an empty result (FD-7)', async t => {
  const f = await lab(t);
  const failing = { ...f.laptop.backend, applications: async () => { throw new MachineServiceError('machine-service /applications: HTTP 503: image catalog unavailable', 503); } } as VmBackend;
  const manager = f.make({ vm: failing, bonjourBrowse: async () => [] });
  await assert.rejects(manager.search({ name: 'Xcode' }), /No machine-service instance answered with an application catalog: laptop .*image catalog unavailable/);
});

test('relay_probe and relay_acquisition_capabilities answer per instance (DC-7x-FED-3)', async t => {
  const f = await lab(t);
  const probe = await f.manager.probe('host') as any;
  assert.equal(probe.relay.reachable, true);
  assert.deepEqual(probe.relay.instances.map((i: any) => [i.instance, i.machine_id, i.reachable, Object.keys(i.images?.images ?? {}).join(',')]), [['laptop', 'id-laptop', true, ''], ['mac-a', 'id-mac-a', true, 'macos26,macos27'], ['mac-b', 'id-mac-b', true, 'macos26,macos27'], ['mac-c', 'id-mac-c', false, '']]);
  const narrowed = await f.manager.probe('host', undefined, 'mac-b') as any;
  assert.deepEqual(narrowed.relay.instances.map((i: any) => i.instance), ['mac-b']);
  const answered = await f.manager.acquisitionCapabilities();
  assert.deepEqual(answered.instances.map(i => [i.instance, 'capabilities' in i]), [['laptop', true], ['mac-a', true], ['mac-b', true], ['mac-c', false]]);
});

test('an image acquisition from a Mac that offers nothing chooses a host, says why, and works through it (DC-7x-FED-4, DC-7x-FED-5)', async t => {
  const f = await lab(t);
  const acquired = await f.manager.acquire({ task: 'xcode', image: 'macos27', extractions: [], ttlHours: 1 }) as any;
  assert.deepEqual(acquired.chosen, { instance: 'mac-a', machine_id: 'id-mac-a', reason: 'chose macos27 (virtual, offer on mac-a)' });
  assert.deepEqual(acquired.backend, { endpoint: 'http://127.0.0.1:7001', instance: 'mac-a', machine_id: 'id-mac-a' });
  assert.deepEqual(f.macA.calls.filter(c => c.startsWith('acquire')), ['acquire macos27']);
  assert.equal(f.laptop.calls.some(c => c.startsWith('acquire')), false);
  assert.equal(f.macA.leases.size, 1);
  assert.match(await readFile(f.registryPath, 'utf8'), /mac-a \(machine-service http:\/\/127\.0\.0\.1:7001; relay-xcode-/);

  // A new process of the session finds the owner again by machine_id after a rename, and releases there.
  f.macA.state.name = 'mac-a-renamed';
  await f.manager.cleanup('process restart');
  const restarted = f.make();
  t.after(() => restarted.cleanup('test teardown').catch(() => {}));
  const released = await restarted.release(acquired.guest);
  assert.equal(released.released, true);
  assert.equal(f.macA.leases.size, 0);
  assert.equal(f.macA.calls.filter(c => c.startsWith('release')).length, 1);
});

test('a capacity refusal passes to the next instance; an explicit instance pins the acquisition (DC-7x-FED-4)', async t => {
  const f = await lab(t, { refuseA: true });
  const acquired = await f.manager.acquire({ task: 'busy', image: 'macos26', extractions: [], ttlHours: 1 }) as any;
  assert.equal(acquired.chosen.instance, 'mac-b');
  assert.deepEqual(f.macA.calls.filter(c => c.startsWith('acquire')), ['acquire macos26']);
  assert.equal(f.macB.leases.size, 1);
  await f.manager.release(acquired.guest);

  await assert.rejects(f.manager.acquire({ task: 'pinned', image: 'macos26', instance: 'mac-a', extractions: [], ttlHours: 1 }), /macOS VM limit reached/);
  assert.equal(f.macB.leases.size, 0);
  await assert.rejects(f.manager.acquire({ task: 'nowhere', image: 'macos99', extractions: [], ttlHours: 1 }), /Image unavailable: macos99: no machine-service instance offers it.*mac-a: offers macos26, macos27.*mac-c: unreachable/);
  await assert.rejects(f.manager.acquire({ task: 'durable', machine: 'Build-Mac-1', instance: 'mac-a', extractions: [], ttlHours: 1 }), /a durable machine names its own instance/);
});

test('an acquirable offer comes before one at its limit (FD-7)', async t => {
  const f = await lab(t, { aAcquirable: false });
  const acquired = await f.manager.acquire({ task: 'order', image: 'macos26', extractions: [], ttlHours: 1 }) as any;
  assert.equal(acquired.chosen.instance, 'mac-b');
  assert.equal(f.macA.calls.some(c => c.startsWith('acquire')), false);
  await f.manager.release(acquired.guest);
});

test('local-only discovery, as under a selected environment, never browses (machine-service DC-64)', async () => {
  const { discoverInstances } = await import('../src/discovery.js');
  let browsed = 0;
  const local = instance('http://127.0.0.1:7000', 'id-laptop', [], { name: 'laptop' }).backend;
  const found = await discoverInstances({ local, mode: 'bonjour', browse: async () => { browsed++; return []; }, localOnly: true });
  assert.deepEqual([found.instances.map(i => i.name), browsed, found.discoveryError], [['laptop'], 0, undefined]);
  // A test process without a seam is refused real discovery, and says so beside the loopback instance (DC-67).
  const refused = await discoverInstances({ local, mode: 'bonjour' });
  assert.deepEqual(refused.instances.map(i => i.name), ['laptop']);
  assert.match(refused.discoveryError!, /MCP_RELAY_ISOLATED=1/);
});
