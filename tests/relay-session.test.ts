/**
 * The resumable session (vm-service RP-2) against a fake broker over a fake
 * connection: sequence and replay rules, heartbeat, dead-connection bound,
 * resume after drops, duplicates and reordering, expiry and refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeBroker } from './relay-fake-broker.js';
import { FlowWindow, INITIAL_WINDOW, MAX_BODY, MIN_WINDOW, ResumableSession, SeqState, SessionRejected, backoffDelay, decodeEnvelope, encodeEnvelope, type SessionEnd, type Timing } from '../src/relay-session.js';

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

test('SeqState keeps the bytes in flight within the window; one body always goes', () => {
  const s = new SeqState();
  for (let i = 0; i < 5; i++) s.push(Buffer.alloc(10));
  const sent: number[] = [];
  for (let e = s.next(25); e; e = s.next(25)) sent.push(e.seq);
  assert.deepEqual([sent, s.inFlight], [[1, 2], 20]);
  s.ack(1);
  assert.equal(s.inFlight, 10);
  assert.equal(s.next(25)!.seq, 3);
  s.ack(3);
  assert.deepEqual([s.inFlight, s.ackedBytes], [0, 30]);
  assert.equal(s.next(5)!.seq, 4, 'a body above the window goes alone');
  assert.equal(s.next(5), undefined);
  s.resume(3);
  assert.equal(s.inFlight, 0);
});

/** Drive a window on a link of `rate` bytes per second, always backlogged. */
function settle(w: FlowWindow, t0: number, rate: number, secs: number, rtt?: number) {
  let acked = 0, now = t0;
  for (let i = 0; i < secs * 4; i++) { now += 250; acked += rate / 4; w.observe(now, acked, true, rtt); }
  return now;
}

test('the window drains within a third of the dead bound at the measured rate, plus the round trip', () => {
  const w = new FlowWindow(15_000);
  assert.equal(w.window, INITIAL_WINDOW);
  settle(w, 0, 4e6, 12);
  assert.ok(Math.abs(w.window / 4e6 - 5) < 0.2, `drains in ${w.window / 4e6} s`);
  const r = new FlowWindow(15_000);
  settle(r, 0, 4e6, 12, 1700);
  assert.ok(Math.abs(r.window / 4e6 - 6.7) < 0.2, `holds ${r.window / 4e6} s`);
  const fast = new FlowWindow(15_000); settle(fast, 0, 1e9, 5);
  assert.equal(fast.window, 64 << 20, 'at most the replay buffer');
  const slow = new FlowWindow(15_000); settle(slow, 0, 10e3, 5);
  assert.equal(slow.window, MIN_WINDOW, 'at least one message');
});

test('the first window drains within a third of the dead bound on a slow link (machine-service DC-302)', () => {
  // At 0.5 MB/s a 4 MiB first window takes 8.4 s to drain, more than a third
  // of a 15 s dead bound, so its connection would be declared dead before the
  // window measured the link; the 1 MiB floor drains in 2.1 s.
  const deadMs = 15_000, rate = 0.5e6;
  const w = new FlowWindow(deadMs);
  assert.equal(w.window, MIN_WINDOW, 'the first window is the floor');
  assert.ok(w.window / rate * 1000 < deadMs / 3, `drains in ${(w.window / rate).toFixed(1)} s`);
  assert.ok((4 << 20) / rate * 1000 > deadMs / 3, 'a 4 MiB first window would not');
});

test('acknowledgements released in a burst do not inflate the window, and idle time is no measurement', () => {
  const w = new FlowWindow(15_000);
  let acked = 0, largest = 0;
  for (let step = 1; step <= 160; step++) {
    if (step % 32 === 0) acked += 8 * 4e6;
    w.observe(step * 250, acked, true);
    largest = Math.max(largest, w.window);
  }
  assert.ok(largest / 4e6 <= 8.5, `grew to ${largest / 4e6} s of the link`);
  const before = w.window;
  w.observe(3_600_000, acked, false);
  w.observe(3_601_000, acked, true); w.observe(3_602_000, acked, true);
  assert.equal(w.window, before);
});

test('a connection holds no more than its window in flight while acknowledgements are held, and refills as they arrive', async t => {
  const broker = new FakeBroker();
  broker.app = () => {};
  const s = await open(broker, { ...FAST, deadMs: 5000, heartbeatMs: 1000 });
  t.after(() => s.session.close());
  broker.holdAcks = true;
  const n = 12;
  for (let i = 0; i < n; i++) s.session.send(Buffer.alloc(MAX_BODY));
  const envelopes = () => broker.received.filter(r => r.kind === 'envelope').length;
  await until(() => envelopes() >= 1, 3000, 'the first window');
  await sleep(100);
  assert.equal(envelopes(), Math.max(1, Math.floor(INITIAL_WINDOW / MAX_BODY)), 'the initial window, no more');
  broker.holdAcks = false;
  broker.ackNow();
  await until(() => envelopes() === n, 3000, 'the rest after the acknowledgement');
  await until(() => s.session.unacknowledged === 0, 3000, 'everything acknowledged');
  assert.ok(s.session.minRttMs !== undefined);
  assert.deepEqual(s.events, [], 'no reconnect');
});

test('bodies in flight whose acknowledgement does not advance for the bound still end the connection, and resume', async t => {
  const broker = new FakeBroker();
  broker.app = () => {};
  const s = await open(broker);
  t.after(() => s.session.close());
  broker.holdAcks = true;
  const started = Date.now();
  s.session.send(Buffer.from('held'));
  await until(() => s.events.includes('lost'), 3000, 'the stall');
  const detected = Date.now() - started;
  assert.ok(detected >= FAST.deadMs! - 20 && detected <= FAST.deadMs! + 150, `detected after ${detected} ms`);
  broker.holdAcks = false;
  await until(() => s.events.includes('resumed') && s.session.unacknowledged === 0, 3000, 'the resume');
});
