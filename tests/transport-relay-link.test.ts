/**
 * A run's steps over the relay link (DC-94): the transport, Transfer and
 * MachineService over a RelayClient to the fake broker, whose relay agent runs
 * each command for real in a temporary folder that stands in for the guest.
 * A step that only looks at the guest and whose execution the link lost is
 * made again under a new execution ID, within a bound; the receiver's dispatch
 * is never sent again. Faults are driven by the operations themselves, not by
 * timers.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FramedRequest } from '@wezzard/relay-driver-host-sdk';
import { FakeBroker, FakeRelay } from './relay-fake-broker.js';
import { MachineService, MachineServiceError } from '../src/machine-service.js';
import { caFingerprint, lostExecution, RelayUncertainError, type Op } from '../src/relay-client.js';
import { LOST_STEP_RETRIES, Transfer, type VmChannel } from '../src/transfer.js';
import { VmTransport } from '../src/transport.js';
import { command } from '../src/util.js';
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
const completed = { executionId: 'execution-1', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } }, stdout: 'done\n', stderr: '' };
const request = (): FramedRequest => ({
  executionId: 'execution-1', sessionId: 'session-1', attemptId: 'attempt-1',
  kind: 'code', language: 'javascript', code: 'fixture()', codeSha256: '0'.repeat(64), snapshots: { afterIntervalMs: 0 },
});
/** The presence check's own text (transport.ts PRESENT). */
const PRESENCE = 'isFile();}catch(e){if(e.code';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-link-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guest = join(root, 'guest'), host = join(root, 'host');
  await mkdir(guest); await mkdir(host);
  const guestReceipt = join(guest, 'state/receiver/receipts/execution-1.json');
  // The receiver, as the real one does: a started marker, then the script's receipt; each run is counted.
  await writeFile(join(guest, 'receiver.mjs'), `import fs from 'node:fs';import p from 'node:path';const root=process.env.RELAY_RUNTIME_ROOT;const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));fs.appendFileSync(p.join(root,'runs.log'),request.executionId+'\\n');const started=p.join(root,'state/receiver/started',request.executionId+'.json');fs.mkdirSync(p.dirname(started),{recursive:true});fs.writeFileSync(started,'{}');const receipt=p.join(root,'state/receiver/receipts',request.executionId+'.json');fs.mkdirSync(p.dirname(receipt),{recursive:true});fs.writeFileSync(receipt,${JSON.stringify(JSON.stringify(completed))});`);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) { /* drain */ }
    const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ ok: true, service: 'machine-service', relay_url: relayUrl, relay_ca_sha256: fingerprint });
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const broker = new FakeBroker(), relay = new FakeRelay(broker);
  // The guest is this folder: commands run here, writes and reads are its files.
  relay.run = async line => {
    const result = await command(['/bin/sh', '-c', line], { timeoutMs: 60000, maxBytes: 16 * 1024 * 1024 });
    return { rc: result.code, output: Buffer.from(result.code === 0 ? result.stdout : result.stdout + result.stderr) };
  };
  relay.writeTo = (path, bytes) => writeFileSync(path, bytes);
  relay.readFrom = path => { try { return readFileSync(path); } catch { return undefined; } };
  // No timing window under a second: the losses come from the operations, and a dead connection takes 10 s.
  const service = new MachineService({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, relay: { dial: broker.dial, timing: { heartbeatMs: 1000, deadMs: 10000, tickMs: 10, backoffInitialMs: 5, backoffMaxMs: 40 } } });
  service.useRelay('vm-1', { link: 'relay', relay: { url: relayUrl, credential: 'good-credential', ca_sha256: fingerprint, ca_pem: pem } });
  t.after(async () => { await service.release('vm-1').catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); });

  // As the manager's channel (src/manager.ts `channel`), without the owner lookup.
  const channel: VmChannel = {
    exec: async (name, argv, timeoutMs = 180000, options) => {
      const result = await service.exec(name, { argv, timeout: Math.ceil(timeoutMs / 1000), ...(options?.executionId ? { execution_id: options.executionId } : {}) }, { timeoutMs: options?.timeoutMs ?? timeoutMs + 30000, signal: options?.signal });
      return { stdout: result.output, stderr: result.output, code: result.rc };
    },
    push: (name, local_path, remote_path) => service.push(name, { local_path, remote_path }),
    pull: (name, remote_path, local_path, options) => service.pull(name, { remote_path, local_path }, options),
  };
  const retries: string[] = [];
  const transfer = new Transfer(channel, 'vm-1', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), lostRetryDelayMs: 20, onRetry: async event => { retries.push(event.diagnostic); } });
  const transport = new VmTransport(transfer, guest, host, 'fixture-unused-driver');
  transport.because = 'Protocol fixture: no user interaction';
  const runs = async () => (await readFile(join(guest, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const command_ = (op: Op) => typeof op === 'object' && 'exec' in op ? op.exec.command : '';
  /** The steps that look at the run's receipt, other than the presence check. */
  const receiptLook = (op: Op) => command_(op).includes(guestReceipt) && !command_(op).includes(PRESENCE) && !command_(op).includes('receiver.mjs');
  const dispatch = (op: Op) => command_(op).includes('receiver.mjs');
  return { relay, transport, guest, host, guestReceipt, runs, retries, receiptLook, dispatch, presence: (op: Op) => command_(op).includes(PRESENCE) };
}

// The four looks at the receipt: its fact, its path check, the path check before the read, and the fact again after it.
for (const nth of [1, 2, 3, 4]) test(`a run whose receipt look ${nth} is lost once still returns the script's outcome, and runs once (DC-94)`, async t => {
  const f = await fixture(t);
  let looks = 0;
  const lost: string[] = [];
  f.relay.lose = (op, execution) => { if (f.receiptLook(op) && ++looks === nth) { lost.push(execution); return 'before'; } return undefined; };
  const result = await f.transport.send(request());
  assert.deepEqual(result, completed, JSON.stringify(result));
  assert.equal(lost.length, 1);
  assert.equal(f.retries.length, 1);
  assert.match(f.retries[0], new RegExp(`neither the broker nor the relay agent has a record of the execution; whether execution ${lost[0]}`));
  assert.ok(f.relay.queries.includes(lost[0]), 'the lost look was queried');
  assert.equal(f.relay.calls.filter(call => call.execution === lost[0]).length, 1, 'the lost look is not sent again under its own execution ID');
  assert.equal(await f.runs(), 1, 'the receiver ran once');
  assert.equal(f.relay.calls.filter(call => call.execution === 'execution-1').length, 1, 'the dispatch went once');
  assert.deepEqual(JSON.parse(await readFile(join(f.host, 'receipts/execution-1.json'), 'utf8')), completed);
  assert.equal(await readFile(join(f.host, 'receiver-receipts/execution-1.json'), 'utf8'), JSON.stringify(completed));
});

for (const when of ['before', 'after'] as const) test(`a lost dispatch of the receiver (${when === 'before' ? 'never ran' : 'ran, then its record was lost'}) stays uncertain and is not sent again (DC-94)`, async t => {
  const f = await fixture(t);
  f.relay.lose = (op, execution) => f.dispatch(op) && execution === 'execution-1' ? when : undefined;
  const result = await f.transport.send(request());
  assert.equal(result.outcome.kind, 'uncertain', JSON.stringify(result));
  assert.match(JSON.stringify(result), /neither the broker nor the relay agent has a record of the execution; whether execution execution-1 took effect is uncertain, and it is not sent again/);
  assert.equal(f.relay.calls.filter(call => call.execution === 'execution-1').length, 1, 'the dispatch is not sent again');
  assert.equal(f.relay.calls.filter(call => f.receiptLook(call.op)).length, 0, 'nothing reads a receipt after a lost dispatch');
  assert.equal(await f.runs(), when === 'before' ? 0 : 1);
  assert.deepEqual(f.retries, []);
});

test('a receipt look lost every time ends the run uncertain after the bound, and the receiver ran once (DC-94)', async t => {
  const f = await fixture(t);
  f.relay.lose = op => f.receiptLook(op) || f.presence(op) ? 'before' : undefined;
  const result = await f.transport.send(request());
  assert.equal(result.outcome.kind, 'uncertain', JSON.stringify(result));
  assert.match(JSON.stringify(result), /neither the broker nor the relay agent has a record of the execution/);
  // The receipt's fact, then the presence check, each made 1 + LOST_STEP_RETRIES times, each under its own execution ID.
  const looks = f.relay.calls.filter(call => f.receiptLook(call.op)), presence = f.relay.calls.filter(call => f.presence(call.op));
  assert.equal(looks.length, 1 + LOST_STEP_RETRIES);
  assert.equal(presence.length, 1 + LOST_STEP_RETRIES);
  assert.equal(new Set([...looks, ...presence].map(call => call.execution)).size, 2 * (1 + LOST_STEP_RETRIES));
  assert.equal(f.retries.length, 2 * LOST_STEP_RETRIES);
  assert.equal(await f.runs(), 1, 'the receiver ran once');
  assert.equal(f.relay.calls.filter(call => call.execution === 'execution-1').length, 1, 'the dispatch went once');
});

test('a receipt look that fails in the guest is not made again (DC-94)', async t => {
  const f = await fixture(t);
  // The receiver writes a directory where the receipt should be: the fact fails in the guest, not on the link.
  await writeFile(join(f.guest, 'receiver.mjs'), `import fs from 'node:fs';import p from 'node:path';const root=process.env.RELAY_RUNTIME_ROOT;fs.appendFileSync(p.join(root,'runs.log'),'run\\n');fs.mkdirSync(p.join(root,'state/receiver/receipts/execution-1.json'),{recursive:true});`);
  const result = await f.transport.send(request());
  assert.equal(result.outcome.kind, 'uncertain', JSON.stringify(result));
  assert.equal(f.relay.calls.filter(call => f.receiptLook(call.op)).length, 1);
  assert.deepEqual(f.retries, []);
  assert.equal(await f.runs(), 1);
});

test('only a loss of the execution itself counts as lost, through its causes (DC-94)', () => {
  const wrap = (cause: Error) => new MachineServiceError(`machine-service relay link: ${cause.message}`, undefined, undefined, { cause });
  assert.equal(lostExecution(wrap(new RelayUncertainError('x', 'the session was lost and neither the broker nor the relay agent has a record of the execution', { lost: true }))), true);
  assert.equal(lostExecution(wrap(new RelayUncertainError('x', 'no outcome within 1000 ms; it may still run, and query tells it later'))), false, 'a timeout is not a loss');
  assert.equal(lostExecution(wrap(new Error('relay: the lease was revoked; the operation never reached its commit point'))), false, 'a session ended for good is not a loss');
  assert.equal(lostExecution(new Error('Guest setup/transfer command failed (1): boom')), false);
  assert.equal(lostExecution(undefined), false);
});
