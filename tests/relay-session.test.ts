/**
 * The resumable session (vm-service RP-2) against a fake broker over a fake
 * connection: sequence and replay rules, heartbeat, dead-connection bound,
 * resume after drops, duplicates and reordering, expiry and refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeBroker } from './relay-fake-broker.js';
import { MAX_BODY, ResumableSession, SeqState, SessionRejected, backoffDelay, decodeEnvelope, encodeEnvelope, type SessionEnd, type Timing } from '../src/relay-session.js';

const FAST: Partial<Timing> = { heartbeatMs: 40, deadMs: 200, handshakeMs: 500, backoffInitialMs: 5, backoffMaxMs: 40, tickMs: 10, openMs: 1000 };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(check: () => boolean, ms = 3000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await sleep(5); }
}

async function open(broker: FakeBroker, timing: Partial<Timing> = FAST) {
  const bodies: string[] = [];
  let end: SessionEnd | undefined;
  const events: string[] = [];
  const session = await ResumableSession.open({ dial: broker.dial, credential: broker.credential, timing, onBody: body => bodies.push(body.toString()), onEnd: e => { end = e; }, onEvent: e => events.push(e.kind) });
  return { session, bodies, events, end: () => end };
}

test('SeqState delivers in order, drops duplicates, refuses gaps and replays what the peer lacks', () => {
  const s = new SeqState();
  assert.equal(s.accept({ seq: 1, ack: 0, body: Buffer.from('a') })?.toString(), 'a');
  assert.equal(s.accept({ seq: 1, ack: 0, body: Buffer.from('a') }), undefined, 'a duplicate is dropped');
  assert.throws(() => s.accept({ seq: 3, ack: 0, body: Buffer.from('c') }), /gap in sequence: expected 2, got 3/);
  const out = new SeqState();
  for (const body of ['a', 'b', 'c']) out.push(Buffer.from(body));
  out.resume(0);
  assert.deepEqual([out.next()!.seq, out.next()!.seq], [1, 2]);
  out.resume(1);
  assert.deepEqual([out.next()!.seq, out.next()!.seq, out.next()], [2, 3, undefined], 'after a resume the bodies above the peer\'s received go again');
  out.ack(3);
  assert.equal(out.outboxBytes, 0);
  assert.throws(() => out.ack(4), /beyond the last sent sequence/);
  assert.throws(() => out.resume(2), /below its earlier acknowledgement/);
});

test('envelopes are two big-endian u64 and the body; backoff doubles from 250 ms to 5 s with jitter in the upper half', () => {
  const bytes = encodeEnvelope({ seq: 2 ** 40 + 3, ack: 7, body: Buffer.from('opaque') });
  assert.equal(bytes.length, 22);
  assert.equal(bytes.readBigUInt64BE(0), BigInt(2 ** 40 + 3));
  assert.deepEqual(decodeEnvelope(bytes), { seq: 2 ** 40 + 3, ack: 7, body: Buffer.from('opaque') });
  assert.throws(() => decodeEnvelope(Buffer.alloc(15)), /shorter than its header/);
  assert.equal(backoffDelay(0, 0), 125); assert.equal(backoffDelay(0, 1), 250); assert.equal(backoffDelay(1, 1), 500);
  assert.equal(backoffDelay(5, 1), 5000); assert.equal(backoffDelay(40, 1), 5000); assert.equal(backoffDelay(40, 0), 2500);
});

test('a session opens with hello and carries bodies both ways', async t => {
  const broker = new FakeBroker();
  const s = await open(broker);
  t.after(() => s.session.close());
  const hello = broker.received.find(r => r.kind === 'hello')!.value;
  assert.deepEqual({ ...hello, credential: '<redacted>' }, { type: 'hello', version: 1, session: null, received: 0, credential: '<redacted>', attributes: { role: 'client' } });
  for (let i = 0; i < 20; i++) s.session.send(Buffer.from(`m${i}`));
  await until(() => s.bodies.length === 20, 3000, 'echoes');
  assert.deepEqual(s.bodies, Array.from({ length: 20 }, (_, i) => `echo:m${i}`));
  await until(() => s.session.unacknowledged === 0, 3000, 'acknowledgements');
  assert.throws(() => s.session.send(Buffer.alloc(MAX_BODY + 1)), /exceeds/);
});

test('an idle session sends an ack as its heartbeat within each heartbeat interval', async t => {
  const broker = new FakeBroker();
  broker.heartbeatMs = 30; // the broker's lower heartbeat_ms wins
  const s = await open(broker, { ...FAST, heartbeatMs: 1000, deadMs: 5000 });
  t.after(() => s.session.close());
  const before = broker.ackCount();
  await sleep(400);
  assert.ok(broker.ackCount() - before >= 6, `only ${broker.ackCount() - before} heartbeats in 400 ms`);
  assert.equal(s.end(), undefined);
});

test('dropped connections resume, and every body arrives once and in order both ways', async t => {
  const broker = new FakeBroker();
  const s = await open(broker);
  t.after(() => s.session.close());
  for (let i = 0; i < 200; i++) {
    s.session.send(Buffer.from(`m${i}`));
    if (i % 37 === 5) broker.dropAll();
    if (i % 50 === 9) s.session.dropConnection();
    if (i % 10 === 0) await sleep(2);
  }
  await until(() => s.bodies.length >= 200, 8000, 'every echo');
  await sleep(50);
  assert.deepEqual(s.bodies, Array.from({ length: 200 }, (_, i) => `echo:m${i}`));
  assert.ok(s.events.includes('resumed'));
  assert.ok(s.events.filter(e => e === 'lost').length >= 5, 'the connections were dropped');
  assert.equal(s.end(), undefined);
});

test('a duplicated envelope is delivered once; a reordered one breaks the connection, which resumes in order', async t => {
  const broker = new FakeBroker();
  const s = await open(broker);
  t.after(() => s.session.close());
  broker.duplicateNext = true;
  s.session.send(Buffer.from('one'));
  await until(() => s.bodies.length === 1);
  await sleep(30);
  assert.deepEqual(s.bodies, ['echo:one']);
  broker.reorderNext = true;
  s.session.send(Buffer.from('two'));
  s.session.send(Buffer.from('three'));
  await until(() => s.bodies.length === 3, 3000, 'the reordered bodies');
  assert.deepEqual(s.bodies, ['echo:one', 'echo:two', 'echo:three']);
  assert.ok(s.events.includes('lost') && s.events.includes('resumed'), 'the gap closed the connection and the session resumed');
});

test('a silent connection is dead after the bound and the session resumes on a new one', async t => {
  const broker = new FakeBroker();
  const s = await open(broker);
  t.after(() => s.session.close());
  broker.blackhole = true;
  s.session.send(Buffer.from('lost in the hole'));
  await sleep(100);
  broker.blackhole = false;
  await until(() => s.events.includes('resumed'), 3000, 'a resume after the dead bound');
  await until(() => s.bodies.length === 1);
  assert.deepEqual(s.bodies, ['echo:lost in the hole']);
});

test('a session the broker forgot ends as expired with its reason', async t => {
  const broker = new FakeBroker();
  const s = await open(broker);
  t.after(() => s.session.close());
  broker.forget();
  await until(() => s.end() !== undefined, 3000, 'the end');
  assert.deepEqual(s.end(), { kind: 'expired', reason: 'unknown' });
  assert.throws(() => s.session.send(Buffer.from('x')), /ended/);
});

test('a session no broker answers for its grace period ends as grace_elapsed', async t => {
  const broker = new FakeBroker();
  broker.graceMs = 100;
  const s = await open(broker);
  t.after(() => s.session.close());
  broker.refuse = 1_000_000;
  broker.dropAll();
  await until(() => s.end() !== undefined, 3000, 'the end');
  assert.deepEqual(s.end(), { kind: 'expired', reason: 'grace_elapsed' });
});

test('a refused credential fails the open; a refused resume ends the session; bye closes it either way', async t => {
  const broker = new FakeBroker();
  await assert.rejects(ResumableSession.open({ dial: broker.dial, credential: 'wrong', timing: FAST, onBody: () => {}, onEnd: () => {} }), (error: unknown) => error instanceof SessionRejected && error.code === 'unauthorized');
  const s = await open(broker);
  broker.credential = 'revoked-now';
  broker.dropAll();
  await until(() => s.end() !== undefined, 3000, 'the end');
  assert.deepEqual(s.end(), { kind: 'rejected', code: 'unauthorized', message: 'bad credential' });

  broker.credential = 'good-credential';
  const closing = await open(broker);
  closing.session.close();
  await until(() => broker.received.some(r => r.kind === 'bye'), 3000, 'a bye');
  assert.deepEqual(closing.end(), { kind: 'closed', byPeer: false });
  t.after(() => closing.session.close());
});

test('the first connection is retried with backoff while it cannot connect', async t => {
  const broker = new FakeBroker();
  broker.refuse = 3;
  const s = await open(broker);
  t.after(() => s.session.close());
  assert.equal(broker.refuse, 0);
  s.session.send(Buffer.from('after retries'));
  await until(() => s.bodies.length === 1);
});
