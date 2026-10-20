import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayManager } from '../src/manager.js';
import { MachineService } from '../src/machine-service.js';
import { Registry } from '../src/registry.js';
import { createServer } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { relayCall } from '../src/surface.js';

test('search does not recover a durable lease, acquire locks or access registry/capacity', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-search-isolation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const vm = new Proxy({}, { get(_target, key) {
    if (key === 'applications') return async () => { calls.push('applications'); return { schemaVersion: 1, images: [] }; };
    throw new Error(`Unexpected VM access: ${String(key)}`);
  } }) as MachineService;
  const registry = new Proxy({}, { get() { throw new Error('Registry accessed'); } }) as Registry;
  const manager = new RelayManager({ sessionId: 'search-only', project: root, stateRoot: root, vm, registry });
  await mkdir(manager.root, { mode: 0o700 });
  const original = JSON.stringify({ task: 'interrupted', lease: { vm: 'must-not-touch' } });
  await writeFile(join(manager.root, 'lease.json'), original, { mode: 0o600 });
  const response = await relayCall(() => manager, { action: 'search', name: 'Firefox' }, { toolCallId: 'isolation-call' });
  assert.equal(response.isError, false);
  assert.deepEqual(JSON.parse(response.text), { applications: [], truncated: false });
  assert.deepEqual(calls, ['applications']);
  assert.equal(await readFile(join(manager.root, 'lease.json'), 'utf8'), original);
  assert.deepEqual((await readdir(manager.root)).sort(), ['lease.json', 'search-diagnostics']);
  assert.deepEqual(manager.guestStatus(), { active: false });
  await writeFile(join(manager.root, 'search-diagnostics', 'foreign'), 'preserve');
  await assert.rejects(manager.search({ name: 'Firefox' }), /Unrecognized/);
  assert.equal(await readFile(join(manager.root, 'lease.json'), 'utf8'), original);
  assert.deepEqual(calls, ['applications', 'applications']);
});

test('initialized active lease and scheduled heartbeat survive search and diagnostic failure', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-search-active-')));
  const registryPath = join(root, 'AGENTS.md');
  await writeFile(registryPath, '## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n\n## End\n');
  const requests: string[] = [];
  const heartbeats: unknown[] = [];
  let lease: any;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/images') return res.end(JSON.stringify({ images: { ubuntu2404: { base_available: true } } }));
    if (req.url === '/acquire') {
      lease = { vm: 'fixture-search', purpose: body.purpose, image: body.image, image_kind: 'linux', state: 'running', ip: null, env: 'none', created_at: 1, ttl_expires_at: 7201, grace_until: null, warned: false, cpu: null, memory_mb: null, disk_gb: null };
      return res.end(JSON.stringify(lease));
    }
    if (req.url === '/applications') return res.end(JSON.stringify({ schemaVersion: 1, images: [] }));
    if (req.url === '/machines/fixture-search/heartbeat') { heartbeats.push(body); return res.end(JSON.stringify(lease)); }
    if (req.url === '/machines/fixture-search/release') return res.end(JSON.stringify({ released: true }));
    res.statusCode = 500; res.end(JSON.stringify({ error: 'unexpected fixture request' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const manager = new RelayManager({ sessionId: 'active', project: root, stateRoot: root, outputRoot: join(root, 'packages'),
    registry: new Registry(registryPath), vm: new MachineService({ baseUrl: `http://127.0.0.1:${address.port}` }), heartbeatMs: 1000, verifyDestroyed: async () => true });
  t.after(async () => {
    t.mock.timers.reset();
    try { await manager.release(); await manager.cleanup('fixture teardown'); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await manager.initialize();
  await manager.acquire({ task: 'search-active', image: 'ubuntu2404', extractions: [], ttlHours: 2 });
  // Public equality alone would miss replacing the active timer or owner lock.
  const session = manager as unknown as { loaded: boolean; ownerLock: unknown; guests: Map<string, { enclosure: unknown; timer: unknown; ownerLock: unknown; heartbeating: boolean }> };
  const internals = { get initialized() { return session.loaded; }, get ownerLock() { return session.ownerLock; }, guest: session.guests.get('search-active-1')!,
    get enclosure() { return this.guest.enclosure; }, get timer() { return this.guest.timer; }, get guestLock() { return this.guest.ownerLock; }, get heartbeating() { return this.guest.heartbeating; } };
  assert.equal(internals.initialized, true);
  assert.ok(internals.timer);
  assert.ok(internals.ownerLock); assert.ok(internals.guestLock);
  const identities = { enclosure: internals.enclosure, timer: internals.timer, ownerLock: internals.ownerLock, guestLock: internals.guestLock };
  const status = manager.guestStatus();
  assert.equal('vm' in status && status.vm, 'fixture-search');
  const leaseFile = join(manager.root, 'guests', 'search-active-1', 'lease.json');
  const originalLease = await readFile(leaseFile, 'utf8');
  const originalRegistry = await readFile(registryPath, 'utf8');
  const eventsPath = join(root, 'packages', 'purpose' in status ? status.purpose! : '', 'host', 'events');
  const originalEvents = await readdir(eventsPath);
  const unchanged = async () => {
    assert.equal(internals.initialized, true);
    assert.equal(internals.enclosure, identities.enclosure);
    assert.equal(internals.timer, identities.timer);
    assert.equal(internals.ownerLock, identities.ownerLock);
    assert.equal(internals.guestLock, identities.guestLock);
    assert.deepEqual(manager.guestStatus(), status);
    assert.equal(await readFile(leaseFile, 'utf8'), originalLease);
    assert.equal(await readFile(registryPath, 'utf8'), originalRegistry);
    assert.deepEqual(await readdir(eventsPath), originalEvents);
  };
  const pulse = async () => {
    const count = heartbeats.length;
    t.mock.timers.tick(1000);
    // Drain real loopback HTTP, not a wall-clock sleep or a VM heartbeat.
    const deadline = performance.now() + 2000;
    while ((heartbeats.length === count || internals.heartbeating) && performance.now() < deadline) await nextTurn();
    assert.equal(heartbeats.length, count + 1);
    assert.equal(internals.heartbeating, false);
    assert.deepEqual(heartbeats.at(-1), { ttl_hours: 0.25 }, 'renewal asks for the 15-minute window (H6), not the 2-hour TTL');
    await unchanged();
  };
  await pulse();
  requests.length = 0;
  assert.deepEqual(await manager.search({ name: 'Firefox' }), { applications: [], truncated: false });
  assert.deepEqual(requests, ['GET /applications']);
  await unchanged();
  await pulse();
  await writeFile(join(manager.root, 'search-diagnostics', 'foreign'), 'preserve');
  requests.length = 0;
  await assert.rejects(manager.search({ name: 'Firefox' }), /Unrecognized/);
  assert.deepEqual(requests, ['GET /applications']);
  assert.equal(await readFile(join(manager.root, 'search-diagnostics', 'foreign'), 'utf8'), 'preserve');
  await unchanged();
  await pulse();
});

test('catalog outage is an error with diagnostics, without cleanup or ownership changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-search-outage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vm = { applications: async () => { throw new Error('catalog unavailable'); } } as unknown as MachineService;
  const registry = new Proxy({}, { get() { throw new Error('Registry accessed'); } }) as Registry;
  const manager = new RelayManager({ sessionId: 'outage', project: root, stateRoot: root, vm, registry });
  await assert.rejects(manager.search({ name: 'Firefox' }), /catalog unavailable/);
  assert.deepEqual(await readdir(manager.root), ['search-diagnostics']);
  const files = await readdir(join(manager.root, 'search-diagnostics'));
  const diagnostic = JSON.parse(await readFile(join(manager.root, 'search-diagnostics', files[0]!), 'utf8'));
  assert.equal(diagnostic.status, 'error');
  assert.equal('truncated' in diagnostic, false);
});
