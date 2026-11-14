/**
 * The relay client (vm-service RP-4 to RP-7) over the fake broker: calls with
 * execution IDs, chunked uploads and streams under the 1 MiB cap, and the
 * recovery after a session that cannot resume: completed and running
 * executions are taken from the record and never run twice, unknown ones stay
 * uncertain and are never sent again.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FakeBroker, FakeRelay } from './relay-fake-broker.js';
import { MAX_CHUNK, RELAY_PROTOCOL, RelayClient, RelayUncertainError, UPLOAD_WINDOW, caFingerprint, checkGrant, decodeMessage, encodeChunk, encodeControl, fileSource, type Sink } from '../src/relay-client.js';
import { writeFileSync } from 'node:fs';
import { MAX_BODY, type Timing } from '../src/relay-session.js';
import { childEnvironment } from './isolation.js';
import { sessionGraceMs } from '../src/config.js';

const FAST: Partial<Timing> = { heartbeatMs: 40, deadMs: 300, handshakeMs: 500, backoffInitialMs: 5, backoffMaxMs: 40, tickMs: 10, openMs: 1000 };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const grant = { url: 'wss://broker.example.invalid/relay', credential: 'good-credential', ca_sha256: '', ca_pem: '' };
function fixture(t: test.TestContext) {
  const broker = new FakeBroker(), relay = new FakeRelay(broker);
  const client = new RelayClient(grant, { dial: broker.dial, timing: FAST });
  t.after(() => client.close());
  return { broker, relay, client };
}
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

test('relay messages: a chunk is 0x01, the call as u64 and the data; control messages are one-key JSON or a bare name', () => {
  const chunk = encodeChunk(258, Buffer.from('hi'));
  assert.deepEqual([...chunk.subarray(0, 9)], [1, 0, 0, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(decodeMessage(chunk), { chunk: { call: 258, data: Buffer.from('hi') } });
  assert.equal(encodeControl('heartbeat', undefined).toString(), '"heartbeat"');
  assert.equal(encodeControl('query', { call: 1, execution: 'e' }).toString(), '{"query":{"call":1,"execution":"e"}}');
  assert.deepEqual(decodeMessage(Buffer.from('{"result":{"call":1}}')), { name: 'result', value: { call: 1 } });
  assert.throws(() => encodeChunk(1, Buffer.alloc(MAX_CHUNK + 1)), /exceeds/);
  assert.ok(MAX_CHUNK + 9 <= MAX_BODY, 'a full chunk fits one envelope');
});

test('a grant is used only when the instance advertises the same authority and its PEM hashes to it', () => {
  const pem = testCertificate();
  const fingerprint = caFingerprint(pem);
  assert.equal(fingerprint, sha(new X509Certificate(pem).raw));
  const good = { url: 'wss://studio.local:6241/relay', credential: 'c', ca_sha256: fingerprint, ca_pem: pem };
  const advertised = { relay_url: good.url, relay_ca_sha256: fingerprint };
  assert.equal(checkGrant(good, advertised), undefined);
  assert.match(checkGrant(good, {})!, /does not advertise/);
  assert.match(checkGrant(good, { ...advertised, relay_ca_sha256: '0'.repeat(64) })!, /another authority/);
  assert.match(checkGrant({ ...good, ca_sha256: '0'.repeat(64) }, { ...advertised, relay_ca_sha256: '0'.repeat(64) })!, /does not hash/);
  assert.match(checkGrant({ ...good, url: 'ws://studio.local:6241/relay' }, advertised)!, /loopback/);
  assert.equal(checkGrant({ ...good, url: 'ws://127.0.0.1:6241/relay' }, advertised), undefined);
  assert.match(checkGrant({ ...good, url: 'wss://studio.local:6241/other' }, advertised)!, /at \/relay/);
  assert.match(checkGrant(undefined, advertised)!, /no complete relay grant/);
});

test('exec, write, read, status and query run as calls with execution IDs', async t => {
  const { relay, client } = fixture(t);
  assert.equal((await client.ready()).lease, 'fake-lease');
  const ran = await client.run({ exec: { command: 'echo hi', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'e-1' });
  assert.equal(ran.output.toString(), 'hi\n');
  assert.deepEqual(ran.outcome, { exit: { rc: 0, signal: null, timed_out: false, cancelled: false, output: { size: 3, sha256: sha('hi\n') } } });
  assert.equal(ran.replayed, false);
  const again = await client.run({ exec: { command: 'echo hi', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'e-1' });
  assert.equal(again.replayed, true); assert.equal(again.output.toString(), 'hi\n');
  assert.equal(relay.runs('e-1'), 1, 'a repeated execution ID never runs again');
  const written = await client.run({ write: { path: 'f.bin', name: '', mode: 420 } }, Buffer.from('bytes'));
  assert.deepEqual(written.outcome, { written: { size: 5, sha256: sha('bytes') } });
  const read = await client.run({ read: { path: 'f.bin' } });
  assert.equal(read.output.toString(), 'contents of f.bin');
  assert.ok('status' in (await client.run('status')).outcome);
  assert.deepEqual(await client.query('e-1'), { completed: { op: 'exec', outcome: ran.outcome } });
  assert.equal(await client.query('never-sent'), 'unknown');
});

test('uploads and streams above 1 MiB travel in chunks under the message cap', async t => {
  const { relay, client } = fixture(t);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const written = await client.run({ write: { path: 'big', name: '', mode: null } }, bytes);
  assert.deepEqual(written.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.deepEqual(relay.chunkSizes, [MAX_CHUNK, MAX_CHUNK, MAX_CHUNK, bytes.length - 3 * MAX_CHUNK]);
  const big = await client.run({ exec: { command: 'big', stdin: false, timeout_s: 60 } });
  assert.equal(big.output.length, 3 * 1024 * 1024);
  assert.equal(big.stream?.sha256, sha('x'.repeat(3 * 1024 * 1024)));
});

test('a replayed read has no bytes, so the read goes again under a new execution ID into its sink', async t => {
  const { relay, client } = fixture(t);
  await client.run({ read: { path: 'r' } }, Buffer.alloc(0), { executionId: 'read-1' });
  const parts: Buffer[] = []; let resets = 0;
  const sink: Sink = { write: data => parts.push(data), reset: () => { parts.length = 0; resets++; } };
  const answer = await client.run({ read: { path: 'r' } }, Buffer.alloc(0), { executionId: 'read-1', sink });
  assert.equal(Buffer.concat(parts).toString(), 'contents of r');
  assert.equal(resets, 1);
  assert.notEqual(answer.executionId, 'read-1');
  assert.equal(relay.calls.filter(c => 'read' in (c.op as object)).length, 3);
});

test('a lost session that cannot resume recovers a running execution from the record; it never runs twice', async t => {
  const { broker, relay, client } = fixture(t);
  await client.ready();
  const running = client.run({ exec: { command: 'hold', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'held-1' });
  await waitFor(() => relay.runs('held-1') === 1);
  broker.forget(); // a broker restart: the session is gone, the records stay
  await waitFor(() => relay.queries.includes('held-1'));
  await waitFor(() => relay.calls.filter(c => c.execution === 'held-1').length === 2);
  relay.finish('held-1');
  const answer = await running;
  assert.equal(answer.replayed, true);
  assert.equal(answer.output.toString(), 'held\n');
  assert.equal(relay.runs('held-1'), 1);
  assert.equal(client.sessions, 2);
});

test('a lost session recovers a completed execution as a replay', async t => {
  const { broker, relay, client } = fixture(t);
  await client.ready();
  broker.blackhole = true; // the answer is lost on the way, then the session too
  const done = client.run({ exec: { command: 'echo once', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'once-1' });
  await sleep(20);
  broker.blackhole = false;
  await waitFor(() => relay.runs('once-1') === 1 || relay.calls.length > 0, 'the call reaching the broker');
  broker.forget();
  const answer = await done;
  assert.equal(answer.output.toString(), 'once\n');
  assert.equal(relay.runs('once-1'), 1);
});

test('an execution with no record after an unresumable loss stays uncertain and is never sent again', async t => {
  const { broker, relay, client } = fixture(t);
  await client.ready();
  const pending = client.run({ exec: { command: 'hold', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'lost-1' });
  await waitFor(() => relay.runs('lost-1') === 1);
  relay.forgetRecords = true;
  broker.forget();
  await assert.rejects(pending, (error: unknown) => error instanceof RelayUncertainError && error.executionId === 'lost-1' && /never sent again|not sent again/.test(error.message));
  assert.deepEqual(relay.queries, ['lost-1']);
  assert.equal(relay.calls.filter(c => c.execution === 'lost-1').length, 1, 'the unknown execution was not replayed');
});

test('a revoked lease fails its calls without retry', async t => {
  const { broker, relay, client } = fixture(t);
  await client.ready();
  const pending = client.run({ exec: { command: 'hold', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'rev-1' });
  await waitFor(() => relay.runs('rev-1') === 1);
  const session = [...broker.sessions.values()][0]!;
  broker.send(session, encodeControl('revoked', { reason: 'released' }));
  await sleep(20);
  session.conn!.deliver(JSON.stringify({ type: 'bye' }));
  await assert.rejects(pending, /the lease was released/);
});

test('a call without an outcome by its deadline is uncertain', async t => {
  const { relay, client } = fixture(t);
  await assert.rejects(client.run({ exec: { command: 'hold', stdin: false, timeout_s: 60 } }, Buffer.alloc(0), { executionId: 'slow-1', timeoutMs: 100 }), RelayUncertainError);
  relay.finish('slow-1');
});

// --------------------------------------------------- resumable streams (RP-15)

const pattern = (size: number, seed: number) => { const out = Buffer.allocUnsafe(size); let state = seed | 1; for (let i = 0; i < size; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; out[i] = state & 0xff; } return out; };
const write = (path: string) => ({ write: { path, name: '', mode: null } });

test('the client names relay protocol 2 in its hello', async t => {
  const { broker, client } = fixture(t);
  assert.equal((await client.ready()).protocol, 2);
  assert.deepEqual(broker.received.find(r => r.kind === 'hello')!.value.attributes, { role: 'client', protocol: RELAY_PROTOCOL });
});

test('a client asks for the grace period it was given, and only then', async t => {
  const broker = new FakeBroker(); new FakeRelay(broker);
  const client = new RelayClient(grant, { dial: broker.dial, timing: FAST, graceMs: 2000 });
  t.after(() => client.close());
  await client.ready();
  assert.deepEqual(broker.received.find(r => r.kind === 'hello')!.value.attributes, { role: 'client', protocol: RELAY_PROTOCOL, grace_ms: 2000 });
  assert.equal(sessionGraceMs({}), undefined);
  assert.equal(sessionGraceMs({ MCP_RELAY_SESSION_GRACE_MS: '2000' }), 2000);
  for (const bad of ['999', '600001', '1.5', 'soon']) assert.throws(() => sessionGraceMs({ MCP_RELAY_SESSION_GRACE_MS: bad }), /MCP_RELAY_SESSION_GRACE_MS/, bad);
});

test('an upload keeps within the window beyond the relay agent\'s progress', async t => {
  const { relay, client } = fixture(t);
  await client.ready();
  relay.stallProgress = true;
  const bytes = pattern(UPLOAD_WINDOW + 8 * MAX_CHUNK + 5, 1);
  const pending = client.run(write('w.bin'), bytes, { executionId: 'window-1' });
  await waitFor(() => (relay.held.get('window-1')?.size ?? 0) >= UPLOAD_WINDOW - MAX_CHUNK, 'the window to fill');
  await sleep(100);
  const held = relay.held.get('window-1')!.size;
  assert.ok(held <= UPLOAD_WINDOW + MAX_CHUNK, `${held} bytes went out past no progress`);
  relay.release();
  const answer = await pending;
  assert.deepEqual(answer.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.ok(relay.maxAhead <= UPLOAD_WINDOW + MAX_CHUNK, `${relay.maxAhead}`);
});

test('an upload that ends upload_incomplete continues from the relay agent\'s committed offset', async t => {
  const { relay, client } = fixture(t);
  await client.ready();
  const bytes = pattern(6 * MAX_CHUNK + 333, 2);
  relay.cutUploadAt = 3 * MAX_CHUNK;
  const answer = await client.run({ write_tree: { path: 'tree', name: '' } }, bytes, { executionId: 'cut-1' });
  assert.deepEqual(answer.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.equal(relay.executions.get('cut-1')!.output.equals(bytes), true, 'the agent holds the whole stream, once');
  assert.ok(relay.calls.some(c => c.execution === 'cut-1' && c.resume), 'the upload continued with resume');
  // What was on the way when the upload was cut is dropped; the continuation sends only what the agent lacked.
  const sent = relay.chunkSizes.reduce((a, b) => a + b, 0);
  assert.ok(sent <= 2 * bytes.length - 3 * MAX_CHUNK, `${sent} bytes sent for ${bytes.length}: the continuation restarted from the first byte`);
});

test('an upload whose session cannot resume continues in the next session from the committed offset', async t => {
  const { broker, relay, client } = fixture(t);
  await client.ready();
  relay.stallProgress = true;
  const bytes = pattern(UPLOAD_WINDOW + 4 * MAX_CHUNK, 3);
  const pending = client.run(write('s.bin'), bytes, { executionId: 'lost-up-1' });
  await waitFor(() => (relay.held.get('lost-up-1')?.size ?? 0) >= UPLOAD_WINDOW - MAX_CHUNK, 'the window to fill');
  const held = relay.held.get('lost-up-1')!.size;
  relay.stallProgress = false;
  broker.forget(); // a broker restart: the agent keeps what it holds
  const answer = await pending;
  assert.deepEqual(answer.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.equal(client.sessions, 2);
  assert.ok(relay.calls.some(c => c.execution === 'lost-up-1' && c.resume));
  const sent = relay.chunkSizes.reduce((a, b) => a + b, 0);
  assert.ok(sent <= bytes.length + MAX_CHUNK, `${sent} bytes sent; ${held} were held before the loss`);
});

test('a read cut by a session that cannot resume continues at its offset under a new execution ID', async t => {
  const { relay, client } = fixture(t);
  await client.ready();
  const data = pattern(5 * MAX_CHUNK + 77, 4);
  relay.files.set('big.bin', data);
  relay.cutReadAt = 2 * MAX_CHUNK;
  const parts: Buffer[] = []; let resets = 0;
  const sink: Sink = { write: part => parts.push(Buffer.from(part)), reset: () => { parts.length = 0; resets++; } };
  const answer = await client.run({ read: { path: 'big.bin' } }, Buffer.alloc(0), { executionId: 'read-cut', sink });
  assert.ok(Buffer.concat(parts).equals(data));
  assert.equal(resets, 0, 'no byte arrived twice');
  assert.deepEqual(answer.stream, { size: data.length, sha256: sha(data) });
  assert.notEqual(answer.executionId, 'read-cut');
  assert.ok(relay.calls.some(c => 'read' in (c.op as object) && c.offset === 2 * MAX_CHUNK));
});

test('a file uploads from the disk, read at any offset', async t => {
  const { relay, client } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'relay-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = pattern(3 * MAX_CHUNK + 9, 5);
  writeFileSync(join(dir, 'f.bin'), bytes);
  const source = await fileSource(join(dir, 'f.bin'));
  assert.deepEqual({ size: source.size, sha256: source.sha256 }, { size: bytes.length, sha256: sha(bytes) });
  assert.ok((await source.read(MAX_CHUNK + 1, 10)).equals(bytes.subarray(MAX_CHUNK + 1, MAX_CHUNK + 11)));
  relay.cutUploadAt = MAX_CHUNK + 1;
  const answer = await client.run(write('f.bin'), source, { executionId: 'file-1' });
  assert.deepEqual(answer.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.ok(relay.executions.get('file-1')!.output.equals(bytes));
});

test('under a broker of protocol 1 the client sends no resume and waits for no progress', async t => {
  const broker = new FakeBroker(), relay = new FakeRelay(broker);
  relay.protocol = 1;
  const client = new RelayClient(grant, { dial: broker.dial, timing: FAST });
  t.after(() => client.close());
  const bytes = pattern(UPLOAD_WINDOW + 2 * MAX_CHUNK, 6);
  const answer = await client.run(write('v1.bin'), bytes, { executionId: 'v1-1' });
  assert.deepEqual(answer.outcome, { written: { size: bytes.length, sha256: sha(bytes) } });
  assert.ok(relay.calls.every(c => !c.resume));
});

async function waitFor(check: () => boolean, what = 'condition', ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await sleep(5); }
}

/** A throwaway self-signed certificate, only to exercise the fingerprint rule. */
function testCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ca-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=relay-test', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem')], { stdio: 'ignore', env: childEnvironment() });
    return readFileSync(join(dir, 'ca.pem'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
