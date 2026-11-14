/**
 * Routing in MachineService (docs/relay-agent-link.md §3, §6): a lease whose
 * record says `link: relay` and whose grant matches what the instance
 * advertises runs its guest operations through the broker session; an
 * `ssh-fallback` lease, or an instance that does not advertise the broker,
 * keeps the HTTP operations.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FakeBroker, FakeRelay } from './relay-fake-broker.js';
import { MachineService, shellQuote } from '../src/machine-service.js';
import { caFingerprint } from '../src/relay-client.js';
import { childEnvironment } from './isolation.js';

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ca-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=relay-test', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem')], { stdio: 'ignore', env: childEnvironment() });
    return readFileSync(join(dir, 'ca.pem'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const pem = certificate(), fingerprint = caFingerprint(pem);
const relayUrl = 'wss://broker.example.invalid:6241/relay';

async function fixture(t: TestContext, { link = 'relay', advertise = true }: { link?: string; advertise?: boolean } = {}) {
  const requests: string[] = [];
  const lease = (vm: string) => ({ vm, purpose: 'p', image: 'ubuntu2404', image_kind: 'linux', env: 'none', state: 'running', created_at: 1, ttl_expires_at: 2, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null, link });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) { /* drain */ }
    requests.push(req.url!);
    const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ ok: true, service: 'machine-service', ...(advertise ? { relay_url: relayUrl, relay_ca_sha256: fingerprint } : {}) });
    if (req.url === '/acquire') return send({ ...lease('vm-1'), ...(link === 'relay' ? { relay: { url: relayUrl, credential: 'good-credential', ca_sha256: fingerprint, ca_pem: pem } } : { link_reason: 'the relay agent did not register within 120s' }) });
    if (req.url === '/machines/vm-1/exec') return send({ vm: 'vm-1', rc: 0, output: 'over http\n' });
    if (req.url === '/machines/vm-1/release') return send({ vm: 'vm-1', released: true, reason: 'done' });
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const broker = new FakeBroker(), relay = new FakeRelay(broker);
  const service = new MachineService({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, relay: { dial: broker.dial, timing: { heartbeatMs: 40, deadMs: 300, tickMs: 10, backoffInitialMs: 5, backoffMaxMs: 40 } } });
  t.after(async () => { await service.release('vm-1').catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { service, requests, relay };
}

test('argv is quoted as machine-service quotes it for a command line', () => {
  assert.equal(['echo', "it's", 'a b', '', 'x=1,y:2@/p.%+'].map(shellQuote).join(' '), `echo 'it'"'"'s' 'a b' '' x=1,y:2@/p.%+`);
});

test('a relay lease runs exec through the broker session under its execution ID', async t => {
  const f = await fixture(t);
  const lease = await f.service.acquire({ purpose: 'p', image: 'ubuntu2404' });
  assert.equal(lease.link, 'relay');
  assert.deepEqual(await f.service.exec('vm-1', { argv: ['echo', 'a b'], execution_id: 'run-7' }), { vm: 'vm-1', rc: 0, output: "'a b'\n", link: 'relay', execution_id: 'run-7' });
  assert.deepEqual(f.relay.calls.map(c => [c.execution, c.op]), [['run-7', { exec: { command: "echo 'a b'", stdin: false, timeout_s: 600 } }]]);
  assert.deepEqual(f.requests, ['/acquire', '/health'], 'no HTTP exec');
});

test('an ssh-fallback lease keeps the HTTP operations', async t => {
  const f = await fixture(t, { link: 'ssh-fallback' });
  await f.service.acquire({ purpose: 'p', image: 'ubuntu2404' });
  assert.equal((await f.service.exec('vm-1', { argv: ['true'] })).output, 'over http\n');
  assert.equal(await f.service.relayLink('vm-1'), false);
  assert.deepEqual(f.relay.calls, []);
});

test('a relay lease on an instance that does not advertise the broker keeps the HTTP operations', async t => {
  const f = await fixture(t, { advertise: false });
  await f.service.acquire({ purpose: 'p', image: 'ubuntu2404' });
  assert.equal((await f.service.exec('vm-1', { argv: ['true'] })).output, 'over http\n');
  assert.deepEqual(f.relay.calls, []);
});

test('a lease adopted after a restart routes through the broker again', async t => {
  const f = await fixture(t);
  f.service.useRelay('vm-1', { link: 'relay', relay: { url: relayUrl, credential: 'good-credential', ca_sha256: fingerprint, ca_pem: pem } });
  assert.deepEqual(await f.service.exec('vm-1', { script: 'echo hi', execution_id: 's-1' }), { vm: 'vm-1', rc: 0, output: 'script: echo hi', link: 'relay', execution_id: 's-1' });
  assert.deepEqual(f.relay.calls.map(c => [c.op, c.size]), [[{ script: { timeout_s: 600 } }, 7]]);
  f.service.useRelay('vm-1', { link: 'ssh-fallback' });
  assert.equal((await f.service.exec('vm-1', { argv: ['true'] })).output, 'over http\n');
});
