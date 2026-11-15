import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { FramedRequest } from '@wezzard/relay-driver-host-sdk';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { VmTransport } from '../src/transport.js';
import { command, hash } from '../src/util.js';

const request = (patch: Partial<FramedRequest> = {}): FramedRequest => ({
  executionId: 'execution-1', sessionId: 'session-1', attemptId: 'attempt-1',
  kind: 'code', language: 'javascript', code: 'fixture()', codeSha256: '0'.repeat(64), snapshots: { afterIntervalMs: 0 }, ...patch,
});
const completed = { executionId: 'execution-1', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } };

/** Local protocol fixture only. No VM, display, real input or browser. */
async function fixture(t: TestContext, response: unknown = completed, options: { absent?: boolean; exit?: number; malformed?: boolean; declined?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-transport-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guest = join(root, 'guest'), host = join(root, 'host'); await mkdir(guest); await mkdir(host);
  const guestReceipt = join(guest, 'state/receiver/receipts/execution-1.json');
  const originalReceipt = join(host, 'receiver-receipts/execution-1.json');
  // Faithfully emulate the old receiver CLI: persist a receipt then write that
  // same potentially huge, JSON-escaped document to stdout.
  const encoded = options.malformed ? '{malformed json' : JSON.stringify(response);
  await writeFile(join(guest, 'receiver.mjs'), `import fs from 'node:fs';import p from 'node:path';const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const receipt=p.join(process.env.RELAY_RUNTIME_ROOT,'state/receiver',${options.declined ? "'declined'" : "'receipts'"},request.executionId+'.json');if(!${!!options.absent}){fs.mkdirSync(p.dirname(receipt),{recursive:true});fs.writeFileSync(receipt,${JSON.stringify(encoded)});}process.stdout.write(${JSON.stringify(encoded)});process.exitCode=${options.exit ?? 0};`);
  const dispatched: Array<{ argv: string[]; timeout?: number }> = [], stdoutLengths: number[] = [], execs: string[][] = [];
  const channel: VmChannel = {
    exec: async (_name, argv, timeout) => {
      execs.push(argv);
      if (argv[0] === '/usr/bin/env') dispatched.push({ argv, timeout });
      const result = await command(argv, { timeoutMs: 10000, maxBytes: 16 * 1024 * 1024 });
      stdoutLengths.push(result.stdout.length);
      return { ...result, stdout: result.stdout.slice(-64000), stderr: result.stderr.slice(-64000) };
    },
    push: async (_name, local, remote) => copyFile(local, remote),
    pull: async (_name, remote, local) => copyFile(remote, local),
  };
  const transfer = new Transfer(channel, 'fixture', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
  const transport = new VmTransport(transfer, guest, host, 'fixture-unused-driver'); transport.because = 'Protocol fixture: no user interaction';
  return { root, guest, host, channel, transfer, transport, guestReceipt, originalReceipt, dispatched, stdoutLengths, encoded, execs };
}

test('escaped large stdout receipts use verified file framing despite service stdout truncation', async t => {
  const stdout = '\0\n"\\'.repeat(12000);
  const expected = { ...completed, stdout, stderr: '\\"'.repeat(3000) };
  assert.ok(JSON.stringify(expected).length > 64000);
  const f = await fixture(t, expected);
  assert.deepEqual(await f.transport.send(request()), expected);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.stdoutLengths.every(length => length < 1000), 'all exec output is small ack/fact, not escaped receipt');
  const original = await readFile(f.originalReceipt);
  assert.equal(original.toString('utf8'), f.encoded);
  assert.equal(hash(original), hash(await readFile(f.guestReceipt)));
  assert.deepEqual(JSON.parse(await readFile(join(f.host, 'receipts/execution-1.json'), 'utf8')), expected);
  assert.equal(JSON.parse(await readFile(join(f.host, 'requests/execution-1.json'), 'utf8')).because, f.transport.because);
  // The normal path is unchanged: dispatch, then the receipt's fact, pull and recheck, and no look for a declined answer (DC-89).
  assert.ok(!f.execs.some(argv => argv.some(arg => arg.includes('isFile();}catch(e){if(e.code'))), 'no presence probe on the normal path');
  await assert.rejects(readFile(join(f.host, 'receiver-declined/execution-1.json')), { code: 'ENOENT' });
});

const bundle = fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));

test('a run while an earlier run holds the receiver lock is refused, naming that run, not a missing receipt (DC-89)', async t => {
  const f = await fixture(t);
  await copyFile(bundle, join(f.guest, 'receiver.mjs'));
  // The earlier run's receiver is alive (this process) and holds the lock, as after a lost call whose run continues.
  await mkdir(join(f.guest, '.receiver-lock'));
  await writeFile(join(f.guest, '.receiver-lock/owner.json'), JSON.stringify({ pid: process.pid, executionId: 'execution-earlier', active: true, operationPids: [], pendingSpawn: false, settled: false }));
  const result = await f.transport.send(request({ language: 'javascript', code: 'void 0', codeSha256: hash('void 0') }));
  assert.equal(result.outcome.kind, 'refused', JSON.stringify(result));
  assert.match(JSON.stringify(result), /a previous run, execution execution-earlier, still holds the receiver lock/);
  assert.match(JSON.stringify(result), /nothing of this execution started/);
  assert.doesNotMatch(JSON.stringify(result), /ENOENT|lstat|Guest setup\/transfer/);
  assert.equal(f.dispatched.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.host, 'receipts/execution-1.json'), 'utf8')), result);
  assert.deepEqual(JSON.parse(await readFile(join(f.host, 'receiver-declined/execution-1.json'), 'utf8')), result);
  await assert.rejects(readFile(f.originalReceipt), { code: 'ENOENT' }, 'a declined answer is not filed as a receiver receipt');
  await assert.rejects(readFile(join(f.guest, 'state/receiver/started/execution-1.json')), { code: 'ENOENT' });
});

for (const started of [false, true]) test(`a missing receipt with no declined answer says the receiver gave no answer, with the started marker ${started ? 'present' : 'absent'} (DC-89)`, async t => {
  const f = await fixture(t, completed, { absent: true });
  if (started) { await mkdir(join(f.guest, 'state/receiver/started'), { recursive: true }); await writeFile(join(f.guest, 'state/receiver/started/execution-1.json'), '{}'); }
  const result = await f.transport.send(request());
  assert.equal(result.outcome.kind, 'uncertain');
  assert.match(JSON.stringify(result), /the receiver gave no answer/);
  assert.match(JSON.stringify(result), started ? /started marker exists, so it may have started/ : /started marker does not exist/);
  assert.doesNotMatch(JSON.stringify(result), /ENOENT|lstat/);
  assert.equal(f.dispatched.length, 1);
});

for (const answer of [
  { ...completed },
  { executionId: 'wrong-identity', outcome: { kind: 'refused', diagnostic: 'fixture' } },
  { executionId: 'execution-1', outcome: { kind: 'refused' } },
]) test(`a malformed declined answer stays uncertain: ${JSON.stringify(answer)}`, async t => {
  const f = await fixture(t, answer, { declined: true });
  const result = await f.transport.send(request());
  assert.equal(result.outcome.kind, 'uncertain');
  assert.match(JSON.stringify(result), /Malformed receiver|lacks diagnostic/);
  assert.equal(f.dispatched.length, 1);
});

test('a declined uncertain answer is returned as the receiver gave it', async t => {
  const expected = { executionId: 'execution-1', outcome: { kind: 'uncertain', diagnostic: 'execution was already started; it will not be replayed' } };
  const f = await fixture(t, expected, { declined: true });
  assert.deepEqual(await f.transport.send(request()), expected);
});

for (const snapshots of [
  { afterIntervalMs: 5, group: { groupId: 'text', phase: 'last' as const, afterIntervalMs: 299999 } },
  { afterIntervalMs: 150, group: { groupId: 'text', phase: 'last' as const, afterIntervalMs: 0 } },
  { afterIntervalMs: 150, group: { groupId: 'text', phase: 'last' as const } },
]) test(`transport timeout resolves group interval first: ${JSON.stringify(snapshots)}`, async t => {
  const f = await fixture(t); await f.transport.send(request({ snapshots }));
  assert.equal(f.dispatched[0].timeout, 120000 + 180000 + (snapshots.group.afterIntervalMs ?? snapshots.afterIntervalMs));
});

test('explicit execution timeout and diagnostic flag reach the durable receiver request', async t => {
  const f = await fixture(t); f.transport.timeoutMs = 3600000; f.transport.diagnostic = true;
  await f.transport.send(request());
  const sent = JSON.parse(await readFile(join(f.host, 'requests/execution-1.json'), 'utf8'));
  assert.equal(sent.timeoutMs, 3600000); assert.equal(sent.diagnostic, true);
  assert.equal('kind' in sent, false, 'the SDK names a kind; the request the guest reads has none (DC-26)');
  assert.equal('argv' in sent, false, 'nor the interpreter the SDK guessed');
  assert.equal(sent.code, 'fixture()');
  assert.equal(f.dispatched[0].timeout, 3780000);
  assert.deepEqual(f.transport.response, completed);
});

for (const response of [
  { ...completed, executionId: 'wrong-identity' },
  { ...completed, outcome: { kind: 'completed' } },
  { ...completed, outcome: { kind: 'completed', exitStatus: { code: '0', signal: null } } },
  { ...completed, outcome: { kind: 'refused' } },
  null,
]) test(`malformed receipt becomes uncertain without replay and preserves original: ${JSON.stringify(response)}`, async t => {
  const f = await fixture(t, response);
  const result = await f.transport.send(request()); assert.equal(result.outcome.kind, 'uncertain');
  assert.equal(f.dispatched.length, 1); assert.equal(await readFile(f.originalReceipt, 'utf8'), f.encoded);
});

for (const options of [{ absent: true }, { exit: 7 }, { malformed: true }]) test(`receiver failure stays uncertain, never replays: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, completed, options);
  assert.equal((await f.transport.send(request())).outcome.kind, 'uncertain'); assert.equal(f.dispatched.length, 1);
});

for (const kind of ['refused', 'uncertain'] as const) test(`${kind} durable receipt is preserved rather than inferred from stdout`, async t => {
  const expected = { executionId: 'execution-1', outcome: { kind, diagnostic: 'fixture diagnostic' } };
  const f = await fixture(t, expected); assert.deepEqual(await f.transport.send(request()), expected); assert.equal(f.dispatched.length, 1);
});

for (const mutation of ['host-corruption', 'source-change', 'symlink'] as const) test(`receipt ${mutation} fails verification without replay`, async t => {
  const f = await fixture(t);
  f.channel.pull = async (_name, remote, local) => {
    await copyFile(remote, local);
    if (remote !== f.guestReceipt) return;
    if (mutation === 'host-corruption') await writeFile(local, 'corruption');
    if (mutation === 'source-change') await writeFile(remote, 'changed');
    if (mutation === 'symlink') { await rm(remote); await symlink(local, remote); }
  };
  const result = await f.transport.send(request()); assert.equal(result.outcome.kind, 'uncertain');
  assert.match(JSON.stringify(result), /checksum mismatch|Source changed|symlink ancestor/);
  assert.equal(f.dispatched.length, 1);
});

test('lost exec response becomes uncertain without a second dispatch', async t => {
  const f = await fixture(t); const original = f.channel.exec;
  f.channel.exec = async (name, argv, timeout) => { const result = await original(name, argv, timeout); if (argv[0] === '/usr/bin/env') throw Error('lost service response'); return result; };
  const result = await f.transport.send(request()); assert.equal(result.outcome.kind, 'uncertain'); assert.match(JSON.stringify(result), /lost service response/);
  assert.equal(f.dispatched.length, 1);
});

test('receipt directory symlink is rejected and outside contents are untouched', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, dirname(f.originalReceipt));
  const result = await f.transport.send(request()); assert.equal(result.outcome.kind, 'uncertain'); assert.match(JSON.stringify(result), /symlink ancestor/);
  await assert.rejects(readFile(join(outside, 'execution-1.json')), { code: 'ENOENT' });
});

test('unsafe execution identities and missing run intent never stage or dispatch', async t => {
  const f = await fixture(t);
  for (const executionId of ['../escape', '/absolute', '.', '..', 'a/b']) await assert.rejects(f.transport.send(request({ executionId })), /Invalid execution identity/);
  f.transport.because = ''; await assert.rejects(f.transport.send(request()), /execution intent/);
  assert.equal(f.dispatched.length, 0);
});
