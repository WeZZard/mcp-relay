import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadEnvironment, selectedEnvironment, environmentVariables, matchesEnvironment, LEGACY_PROFILE, type VmEnvironment } from '../src/environment.js';
import { relayStateRoot } from '../src/config.js';
import { resolveRegistry } from '../src/registry.js';
import { RelayManager } from '../src/manager.js';

async function fixture(t: TestContext, port = 6249) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-environment-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'image-repo'); await mkdir(join(repo, 'images'), { recursive: true });
  const tart = join(root, 'tart-cli'); const machctl = join(root, 'machctl');
  await writeFile(machctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(tart, `#!${process.execPath}\nconst fs=require('fs'),p=require('path');const home=process.env.TART_HOME;fs.writeFileSync(p.join(home,'observed.txt'),home);console.log(fs.readFileSync(p.join(home,'inventory.json'),'utf8'));\n`, { mode: 0o755 });
  const profile: VmEnvironment = { schemaVersion: 2, id: 'isolated-test', vmServiceUrl: `http://127.0.0.1:${port}`, imageRepository: repo,
    tartHome: join(root, 'tart-store'), serviceStateDir: join(root, 'service'), imageStateDir: join(root, 'image-state'), relayStateDir: join(root, 'relay'), machctlPath: machctl, tartPath: tart };
  const path = join(root, 'environment.json'); await writeFile(path, JSON.stringify(profile));
  const selected = loadEnvironment(path);
  return { root, path, profile, selected };
}

test('profile resolves without creating stores, has stable canonical identity and overrides stale ambient routing', async t => {
  const f = await fixture(t);
  assert.equal(selectedEnvironment({}), undefined);
  assert.equal(relayStateRoot({ env: { VM_ENVIRONMENT_FILE: f.path, MCP_RELAY_STATE_DIR: '/wrong' } }), f.profile.relayStateDir);
  assert.deepEqual(resolveRegistry({ env: { VM_ENVIRONMENT_FILE: f.path, MCP_RELAY_REGISTRY: '/wrong' } }), { path: join(f.profile.relayStateDir, 'registry.md'), managed: true });
  assert.equal(environmentVariables(f.selected).TART_HOME, f.profile.tartHome);
  for (const path of [f.profile.tartHome, f.profile.serviceStateDir, f.profile.imageStateDir, f.profile.relayStateDir]) await assert.rejects(readFile(path), /ENOENT/);
  await writeFile(f.path, JSON.stringify(Object.fromEntries(Object.entries(f.profile).reverse())));
  assert.equal(loadEnvironment(f.path).identity.fingerprint, f.selected.identity.fingerprint);
  assert.ok(matchesEnvironment({ ...f.selected.identity }, f.selected));
  assert.equal(matchesEnvironment({ ...f.selected.identity, tartHome: '/wrong' }, f.selected), false);
  assert.ok(Object.isFrozen(f.selected.profile));
});

test('profile rejects missing fields, ambiguous roots, non-loopback targets, nonexecutables and dangling symlinks', async t => {
  const f = await fixture(t);
  const bad = [
    { ...f.profile, unknown: true }, { ...f.profile, schemaVersion: true }, { ...f.profile, id: 'bad name' },
    { ...f.profile, vmServiceUrl: 'http://example.com:6249' }, { ...f.profile, vmServiceUrl: 'http://127.0.0.1' },
    { ...f.profile, vmServiceUrl: 'http://127.0.0.1:0' }, { ...f.profile, vmServiceUrl: 'http://127.0.0.1:6249/path' },
    { ...f.profile, serviceStateDir: f.profile.tartHome }, { ...f.profile, imageStateDir: join(f.profile.tartHome, 'child') },
    { ...f.profile, relayStateDir: f.profile.imageRepository }, { ...f.profile, tartHome: 'relative' },
    { ...f.profile, tartPath: f.path },
  ];
  for (const value of bad) { await writeFile(f.path, JSON.stringify(value)); assert.throws(() => loadEnvironment(f.path), JSON.stringify(value)); }
  const dangling = join(f.root, 'dangling'); await symlink(join(f.root, 'missing'), dangling);
  await writeFile(f.path, JSON.stringify({ ...f.profile, tartHome: join(dangling, 'vms') }));
  assert.throws(() => loadEnvironment(f.path), /Dangling/);
  await writeFile(f.path, JSON.stringify({ ...f.profile, tartHome: join(f.root, 'home', '.tart', 'child') }));
  assert.throws(() => loadEnvironment(f.path, { HOME: join(f.root, 'home') }), /legacy/);
});

test('AC-45: a profile from before the rename is refused with its fix, and schema 2 with machctlPath exports MACHCTL (DC-27)', async t => {
  const f = await fixture(t);
  const { machctlPath, ...rest } = f.profile;
  const legacy = [
    { ...rest, schemaVersion: 1, vmctlPath: machctlPath },
    { ...rest, schemaVersion: 2, vmctlPath: machctlPath },
    { ...rest, schemaVersion: 1, machctlPath },
    { ...rest, schemaVersion: 2, machctlPath, vmctlPath: machctlPath },
  ];
  for (const value of legacy) {
    await writeFile(f.path, JSON.stringify(value));
    // The loader and the selector the server, doctor and manager use refuse it the same way, naming the fix.
    for (const load of [() => loadEnvironment(f.path), () => selectedEnvironment({ VM_ENVIRONMENT_FILE: f.path })]) {
      assert.throws(load, (error: Error) => error.message === LEGACY_PROFILE, JSON.stringify(value));
    }
  }
  assert.match(LEGACY_PROFILE, /machctlPath/);
  assert.match(LEGACY_PROFILE, /schemaVersion 2/);
  // There is no fallback: the old field is never read, even beside the new one.
  await writeFile(f.path, JSON.stringify(f.profile));
  const selected = loadEnvironment(f.path);
  assert.equal(selected.profile.schemaVersion, 2);
  assert.equal(selected.profile.machctlPath, machctlPath);
  const exported = environmentVariables(selected);
  assert.equal(exported.MACHCTL, machctlPath);
  assert.equal('VMCTL' in exported, false);
  assert.deepEqual(Object.keys(exported).filter(key => key.startsWith('VM_SERVICE_')), []);
  assert.equal(exported.MACHINE_SERVICE_STATE, f.profile.serviceStateDir);
  assert.equal(exported.MACHINE_SERVICE_HOST, '127.0.0.1');
  assert.equal(exported.MACHINE_SERVICE_PORT, '6249');
  // The relay's own names do not change with the service's.
  assert.equal(exported.VM_ENVIRONMENT_FILE, selected.path);
  assert.equal(exported.VM_RELAY_STATE_DIR, f.profile.relayStateDir);
  assert.equal(exported.VM_RELAY_URL, f.profile.vmServiceUrl);
});

test('the service state roots, machine-service and vm-service both, are protected default roots', async t => {
  const f = await fixture(t);
  for (const name of ['machine-service', 'vm-service']) {
    await writeFile(f.path, JSON.stringify({ ...f.profile, serviceStateDir: join(f.root, 'home', '.local', 'state', name) }));
    assert.throws(() => loadEnvironment(f.path, { HOME: join(f.root, 'home') }), /legacy/, name);
  }
});

test('service mismatch refuses allocation and foreign persisted binding before mutation', async t => {
  let identity: unknown, lease: any;
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ ok: true, service: 'machine-service', environment: identity });
    assert.equal(req.headers['x-vm-environment-fingerprint'], (identity as any).fingerprint);
    if (req.url === '/images') return send({ images: { linux: { base_available: true } } });
    if (req.url === '/acquire') {
      lease = { vm: 'same-name', purpose: body.purpose, image: body.image, image_kind: 'linux', state: 'running', env: null, created_at: 1, ttl_expires_at: 9999999999, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null };
      return send(lease);
    }
    if (req.url === '/machines/same-name') return lease ? send(lease) : send({ error: 'unknown VM' }, 404);
    if (req.url === '/machines/same-name/release') { lease = undefined; return send({ released: true }); }
    return send({ error: 'unexpected' }, 500);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(t, address.port);
  identity = { ...f.selected.identity, id: 'wrong-instance' };
  const manager = new RelayManager({ sessionId: 'shared-session', project: f.root, environment: f.selected });
  t.after(async () => { await manager.cleanup('fixture end'); await rm(f.root, { recursive: true, force: true }); });
  await assert.rejects(manager.acquire({ task: 'isolation', image: 'linux', extractions: [] }), /identity mismatch/);
  assert.deepEqual(calls, ['GET /health']);
  identity = f.selected.identity;
  await manager.acquire({ task: 'isolation', image: 'linux', extractions: [] });
  await mkdir(f.profile.tartHome); await writeFile(join(f.profile.tartHome, 'inventory.json'), JSON.stringify([{ Name: 'same-name' }]));
  const old = process.env.TART_HOME; process.env.TART_HOME = join(f.root, 'wrong-store');
  try {
    await assert.rejects(manager.release(), /Tart still lists/);
    assert.equal(await readFile(join(f.profile.tartHome, 'observed.txt'), 'utf8'), f.profile.tartHome);
    await writeFile(join(f.profile.tartHome, 'inventory.json'), '[]');
    await manager.release();
  } finally { if (old === undefined) delete process.env.TART_HOME; else process.env.TART_HOME = old; }
  await manager.acquire({ task: 'retained', image: 'linux', extractions: [] });
  await manager.cleanup('pause retained lease');
  const before = await readFile(join(manager.root, 'guests', 'retained-1', 'lease.json'), 'utf8');
  await writeFile(f.path, JSON.stringify({ ...f.profile, id: 'different-environment' }));
  const other = new RelayManager({ sessionId: 'shared-session', project: f.root, environment: loadEnvironment(f.path) });
  const priorCalls = calls.length;
  await assert.rejects(other.initialize(), /different or unknown VM environment/);
  assert.equal(calls.length, priorCalls);
  assert.equal(await readFile(join(manager.root, 'guests', 'retained-1', 'lease.json'), 'utf8'), before);
  await assert.rejects(other.release(), /different or unknown VM environment/);
  await other.cleanup('failed restoration').catch(() => {});
});
