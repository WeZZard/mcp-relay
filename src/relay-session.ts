/**
 * The client side of machine-service's remote session (vm-service RP-2, RS):
 * one logical session that survives any number of broken connections. Bodies
 * are numbered, kept until the broker acknowledges them, and sent again after
 * a resume; a connection that is silent, or that has bodies in flight while
 * the acknowledgement does not advance, is dropped and the session resumes on
 * a new one with backoff. Liveness is that progress, never the age of the
 * oldest body: an in-flight window adapted from the measured throughput keeps
 * the queue this side builds in the path within a third of the bound (RP-2).
 * The connection itself is a `Dial`, so the state machine runs the same over a
 * real WebSocket and over a test's fake.
 */

/** The largest WebSocket message either side sends or accepts (RP-1, TC-8). */
export const MAX_MESSAGE = 1 << 20;
/** The bytes an envelope adds in front of its body. */
export const ENVELOPE_HEADER = 16;
/** The largest body one envelope carries. */
export const MAX_BODY = MAX_MESSAGE - ENVELOPE_HEADER;
/** The session protocol's `version` in a hello. */
export const SESSION_VERSION = 1;
/** The longest heartbeat interval the transport contract allows (TC-3). */
export const MAX_HEARTBEAT_MS = 30_000;
/** The replay buffer: bytes held unacknowledged before a sender waits (RP-12). */
export const MAX_BUFFERED = 64 << 20;
/** The in-flight window before the first measurement, on each connection (RP-2). */
export const INITIAL_WINDOW = 4 << 20;
/** The smallest in-flight window: one largest message. */
export const MIN_WINDOW = MAX_MESSAGE;

export interface Timing {
  /** Send an `ack` after this long without sending anything; the broker's `heartbeat_ms` lowers it, never above 30 s. */
  heartbeatMs: number;
  /** A connection with nothing received, or with bodies in flight and no new acknowledgement, for this long is dead. */
  deadMs: number;
  /** Bound on opening a connection and its hello/welcome exchange. */
  handshakeMs: number;
  /** Reconnect backoff: a base doubling from this... */
  backoffInitialMs: number;
  /** ...up to this, waiting uniformly between half the base and the base. */
  backoffMaxMs: number;
  /** How often the heartbeat and dead-connection checks run. */
  tickMs: number;
  /** How long the first connection of a session may keep failing to connect before `open` gives up. */
  openMs: number;
}
export const DEFAULT_TIMING: Timing = { heartbeatMs: 5000, deadMs: 15000, handshakeMs: 10000, backoffInitialMs: 250, backoffMaxMs: 5000, tickMs: 250, openMs: 30000 };

/** The delay before reconnect attempt `attempt` (from 0), given a uniform `unit` in [0, 1) (RP-2, RP-12). */
export function backoffDelay(attempt: number, unit: number, timing: Pick<Timing, 'backoffInitialMs' | 'backoffMaxMs'> = DEFAULT_TIMING): number {
  const base = Math.min(timing.backoffInitialMs * 2 ** Math.min(attempt, 16), timing.backoffMaxMs);
  return base * (0.5 + 0.5 * Math.min(Math.max(unit, 0), 1));
}

export interface Envelope { seq: number; ack: number; body: Buffer }
export function encodeEnvelope({ seq, ack, body }: Envelope): Buffer {
  const out = Buffer.allocUnsafe(ENVELOPE_HEADER + body.length);
  out.writeBigUInt64BE(BigInt(seq), 0); out.writeBigUInt64BE(BigInt(ack), 8); body.copy(out, ENVELOPE_HEADER);
  return out;
}
export function decodeEnvelope(bytes: Buffer): Envelope {
  if (bytes.length < ENVELOPE_HEADER) throw new ProtocolError(`an envelope of ${bytes.length} bytes is shorter than its header`);
  const word = (at: number) => { const value = bytes.readBigUInt64BE(at); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError('a sequence number beyond 2^53'); return Number(value); };
  return { seq: word(0), ack: word(8), body: bytes.subarray(ENVELOPE_HEADER) };
}

export class ProtocolError extends Error { constructor(message: string) { super(message); this.name = 'ProtocolError'; } }
/** The broker refused the hello: a retry cannot succeed (RP-2's refusal codes). */
export class SessionRejected extends Error {
  constructor(readonly code: string, message: string) { super(`the broker refused the session: ${code}: ${message}`); this.name = 'SessionRejected'; }
}
/** No connection could be opened or no welcome came in time; a later attempt may succeed. */
export class ConnectError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ConnectError'; } }

/**
 * Sequence numbers, acknowledgements and the replay buffer of one side
 * (RS-2), without I/O: the same rules as the `remote-session` crate's state.
 */
export class SeqState {
  /** The highest sequence number this side assigned. */
  private last = 0;
  /** Bodies the peer has not acknowledged, in order, from `acked + 1`. */
  private readonly outbox: Buffer[] = [];
  outboxBytes = 0;
  /** The highest sequence number the peer acknowledged. */
  acked = 0;
  /** The highest sequence number received without a gap. */
  received = 0;
  /** The highest sequence number written on the current connection. */
  private cursor = 0;
  /** The `received` last told to the peer on the current connection. */
  private ackSent = 0;
  /** Bytes of the bodies written on the current connection and not yet acknowledged. */
  inFlight = 0;
  /** Bytes of every body the peer acknowledged, over the session. */
  ackedBytes = 0;
  push(body: Buffer): number { this.last++; this.outbox.push(body); this.outboxBytes += body.length; return this.last; }
  /** A body to deliver, or undefined for a duplicate; a gap throws. */
  accept(envelope: Envelope): Buffer | undefined {
    this.ack(envelope.ack);
    const expected = this.received + 1;
    if (envelope.seq < expected) return undefined;
    if (envelope.seq > expected) throw new ProtocolError(`gap in sequence: expected ${expected}, got ${envelope.seq}`);
    this.received = envelope.seq;
    return envelope.body;
  }
  /** Drop every buffered body up to `ack`; a stale, lower one is ignored. */
  ack(ack: number) {
    if (ack > this.last) throw new ProtocolError(`acknowledgement ${ack} is beyond the last sent sequence ${this.last}`);
    while (this.acked < ack) {
      const length = this.outbox.shift()!.length;
      this.outboxBytes -= length; this.ackedBytes += length;
      if (this.acked < this.cursor) this.inFlight -= length;
      this.acked++;
    }
  }
  /** A new connection on which the peer reports `peerReceived`: above it is resent, up to it is dropped. */
  resume(peerReceived: number) {
    if (peerReceived < this.acked) throw new ProtocolError(`the broker reports ${peerReceived} received, below its earlier acknowledgement ${this.acked}`);
    this.ack(peerReceived);
    this.cursor = peerReceived; this.inFlight = 0; this.ackSent = 0;
  }
  /** The next envelope to write, if the bytes in flight stay within `window`; with nothing in flight one body always goes. */
  next(window = Infinity): Envelope | undefined {
    if (this.cursor < this.acked) { this.cursor = this.acked; this.inFlight = 0; }
    const body = this.outbox[this.cursor - this.acked];
    if (!body) return undefined;
    if (this.inFlight > 0 && this.inFlight + body.length > window) return undefined;
    this.inFlight += body.length;
    this.cursor++; this.ackSent = this.received;
    return { seq: this.cursor, ack: this.received, body };
  }
  get needsAck() { return this.received > this.ackSent; }
  markAckSent() { this.ackSent = this.received; return this.received; }
  /** Whether bodies written on the current connection wait for an acknowledgement. */
  get awaitingAck() { return this.cursor > this.acked; }
  /** Whether any body waits for an acknowledgement, written or not. */
  get busy() { return this.outbox.length > 0; }
}

/**
 * The in-flight window of one connection (RP-2), the same rule as the
 * `remote-session` crate's: the throughput averaged over the last two drain
 * times of busy time, times the smallest round trip plus the drain time (a
 * third of the dead bound), from one message up to the replay buffer. An
 * average, because a proxy that releases held acknowledgements in a burst
 * makes a short sample read many times the link's rate.
 */
export class FlowWindow {
  window: number;
  private readonly drainMs: number;
  private readonly spanMs: number;
  private readonly points: Array<{ at: number; bytes: number }> = [];
  constructor(deadMs: number, private readonly ceiling = MAX_BUFFERED) {
    this.drainMs = deadMs / 3; this.spanMs = this.drainMs * 2;
    this.window = Math.min(Math.max(INITIAL_WINDOW, MIN_WINDOW), Math.max(ceiling, MIN_WINDOW));
  }
  /** Observe the bytes acknowledged so far, whether bodies wait for one, and the smallest round trip seen. */
  observe(now: number, ackedBytes: number, busy: boolean, minRttMs?: number) {
    if (!busy) { this.points.length = 0; return; }
    const last = this.points.at(-1);
    if (last && now - last.at < 250) return;
    this.points.push({ at: now, bytes: ackedBytes });
    while (this.points.length > 2 && now - this.points[1]!.at >= this.spanMs) this.points.shift();
    const first = this.points[0]!;
    const covered = now - first.at;
    if (covered < Math.max(1000, 2 * (minRttMs ?? 0))) return;
    const rate = (ackedBytes - first.bytes) / covered; // bytes per millisecond
    if (rate <= 0) return; // no progress: the stall rule's business
    const window = Math.floor(rate * (this.drainMs + (minRttMs ?? 0)));
    this.window = Math.min(Math.max(window, MIN_WINDOW), Math.max(this.ceiling, MIN_WINDOW));
  }
}

/** One connection: text frames carry control messages, binary frames envelopes. */
export interface Link { send(data: string | Buffer): void; close(): void }
export interface LinkHandlers { message(data: string | Buffer): void; closed(reason: string): void }
/** Open one connection. It resolves once the connection is open and rejects when it cannot be opened. */
export type Dial = (handlers: LinkHandlers) => Promise<Link>;

export type SessionEnd =
  | { kind: 'closed'; byPeer: boolean }
  /** `expired`/`unknown` from the broker; `grace_elapsed` when no broker answered within the grace period (RP-2). */
  | { kind: 'expired'; reason: 'expired' | 'unknown' | 'grace_elapsed' }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'protocol'; message: string };

export interface SessionOptions {
  dial: Dial;
  credential: string;
  attributes?: Record<string, unknown>;
  timing?: Partial<Timing>;
  random?: () => number;
  /** Each body, once, in order. */
  onBody: (body: Buffer) => void;
  /** Once, when the session ends for good. */
  onEnd: (end: SessionEnd) => void;
  /** A connection was lost or a session resumed; for logs and tests. */
  onEvent?: (event: { kind: 'lost' | 'resumed'; reason?: string }) => void;
}
interface Connected { link: Link; reply: Reply; generation: number }
interface Welcome { type: 'welcome'; session: string; resumed: boolean; received: number; heartbeat_ms: number; grace_ms: number }
type Reply = Welcome | { type: 'expired'; session: string; reason: 'expired' | 'unknown' } | { type: 'error'; code: string; message: string };

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, Math.max(0, ms)));
function parseReply(text: string): Reply {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new ProtocolError('the answer to hello is not JSON'); }
  if (value?.type === 'welcome' && typeof value.session === 'string' && typeof value.resumed === 'boolean' && Number.isSafeInteger(value.received) && Number.isSafeInteger(value.heartbeat_ms) && Number.isSafeInteger(value.grace_ms)) return value;
  if (value?.type === 'expired' && typeof value.session === 'string' && ['expired', 'unknown'].includes(value.reason)) return value;
  if (value?.type === 'error' && typeof value.code === 'string') return { type: 'error', code: value.code, message: String(value.message ?? '') };
  throw new ProtocolError(`unexpected answer to hello: ${text.slice(0, 200)}`);
}

/**
 * A resumable session. `open` makes the first connection, so a wrong URL,
 * trust or credential fails there; later breaks resume in the background
 * until the broker says the session expired, refuses it, or the grace period
 * has passed without a broker answering.
 */
export class ResumableSession {
  readonly timing: Timing;
  id = '';
  ended?: SessionEnd;
  private readonly seq = new SeqState();
  private link?: Link;
  /** Each connection attempt has its own generation; events of an older one are ignored. */
  private generation = 0;
  /** The connection whose welcome is awaited; what arrives after the welcome and before `attach` waits in `early`. */
  private handshake?: { generation: number; answered: boolean; early: Array<string | Buffer>; resolve: (reply: Reply) => void; reject: (error: Error) => void };
  private heartbeatMs: number;
  private graceMs = 600_000;
  private lastRx = 0;
  private lastTx = 0;
  private ackProgress = { acked: 0, at: 0 };
  private flow!: FlowWindow;
  /** Envelopes written on the current connection, for round-trip samples. */
  private written: Array<{ seq: number; at: number }> = [];
  /** The smallest round trip seen, from an envelope's write to the acknowledgement that covers it. */
  minRttMs?: number;
  private ticker?: ReturnType<typeof setInterval>;
  private flushQueued = false;
  private wake?: () => void;
  private readonly drainWaiters: Array<{ limit: number; done: () => void }> = [];
  private readonly random: () => number;

  private constructor(private readonly options: SessionOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    if (!(this.timing.heartbeatMs > 0 && this.timing.heartbeatMs <= MAX_HEARTBEAT_MS)) throw new RangeError('heartbeatMs must be above zero and at most 30 s (TC-3)');
    if (this.timing.deadMs <= this.timing.heartbeatMs) throw new RangeError('deadMs must be longer than heartbeatMs');
    this.heartbeatMs = this.timing.heartbeatMs;
    this.random = options.random ?? Math.random;
  }

  static async open(options: SessionOptions): Promise<ResumableSession> {
    const session = new ResumableSession(options);
    const giveUp = Date.now() + session.timing.openMs;
    for (let attempt = 0; ; attempt++) {
      let connected: Connected;
      try { connected = await session.connect(null, 0); }
      catch (error) {
        if (!(error instanceof ConnectError) || Date.now() >= giveUp) throw error;
        await sleep(Math.min(backoffDelay(attempt, session.random(), session.timing), giveUp - Date.now()));
        continue;
      }
      const { link, reply } = connected;
      if (reply.type === 'error') { session.abandon(link); throw new SessionRejected(reply.code, reply.message); }
      if (reply.type !== 'welcome' || reply.resumed) { session.abandon(link); throw new ProtocolError(`the broker answered a new session with ${JSON.stringify(reply)}`); }
      session.id = reply.session;
      session.attach(connected, reply);
      return session;
    }
  }

  /** Queue one body; it goes out now when connected, else after the session resumes. */
  send(body: Buffer) {
    if (this.ended) throw new Error(`the session has ended (${this.ended.kind})`);
    if (body.length > MAX_BODY) throw new RangeError(`a body of ${body.length} bytes exceeds ${MAX_BODY}`);
    this.seq.push(body);
    this.flush();
  }
  /** Bytes sent and not yet acknowledged. */
  get unacknowledged() { return this.seq.outboxBytes; }
  /** Resolves once at most `limit` bytes wait for an acknowledgement, or the session ended. */
  drained(limit: number): Promise<void> {
    if (this.ended || this.seq.outboxBytes <= limit) return Promise.resolve();
    return new Promise(done => this.drainWaiters.push({ limit, done }));
  }
  /** Close the session on purpose with `bye`; neither side resumes it. */
  close() {
    if (this.ended) return;
    if (this.link) { try { this.link.send(JSON.stringify({ type: 'bye' })); } catch { /* the connection is going anyway */ } }
    this.finish({ kind: 'closed', byPeer: false });
  }
  /** Drop the current connection as a broken link would; the session resumes on a new one. Tests use it. */
  dropConnection(reason = 'dropped') { if (this.link) this.lost(this.generation, reason); }

  private async connect(session: string | null, received: number): Promise<Connected> {
    const generation = ++this.generation;
    const handlers: LinkHandlers = { message: data => this.receive(generation, data), closed: reason => this.lost(generation, reason) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConnectError(`no welcome within ${this.timing.handshakeMs} ms`)), this.timing.handshakeMs); });
    let link: Link | undefined;
    try {
      const opening = this.options.dial(handlers);
      opening.catch(() => {});
      link = await Promise.race([opening, timeout]).catch(error => { throw error instanceof ConnectError ? error : new ConnectError(error instanceof Error ? error.message : String(error), { cause: error }); });
      const answered = new Promise<Reply>((resolve, reject) => { this.handshake = { generation, answered: false, early: [], resolve, reject }; });
      link.send(JSON.stringify({ type: 'hello', version: SESSION_VERSION, session, received, credential: this.options.credential, attributes: this.options.attributes ?? { role: 'client' } }));
      const reply = await Promise.race([answered, timeout]);
      return { link, reply, generation };
    } catch (error) {
      this.abandon(link);
      throw error;
    } finally { clearTimeout(timer); }
  }
  /** Forget a connection that will not carry the session. */
  private abandon(link?: Link) {
    this.handshake = undefined;
    this.generation++;
    try { link?.close(); } catch { /* already gone */ }
  }

  private attach({ link, generation }: Connected, welcome: Welcome) {
    this.seq.resume(welcome.received);
    const early = this.handshake?.generation === generation ? this.handshake.early : [];
    this.handshake = undefined;
    this.link = link;
    this.heartbeatMs = Math.min(this.timing.heartbeatMs, welcome.heartbeat_ms > 0 ? welcome.heartbeat_ms : this.timing.heartbeatMs, MAX_HEARTBEAT_MS);
    this.graceMs = welcome.grace_ms;
    const now = Date.now();
    this.lastRx = now; this.lastTx = now; this.ackProgress = { acked: this.seq.acked, at: now };
    this.flow = new FlowWindow(this.timing.deadMs); this.written = [];
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(generation), this.timing.tickMs);
    this.ticker.unref?.();
    this.settleDrains();
    this.flush();
    for (const data of early) this.receive(generation, data);
  }

  private receive(generation: number, data: string | Buffer) {
    if (generation !== this.generation || this.ended) return;
    this.lastRx = Date.now();
    const handshake = this.handshake;
    if (handshake?.generation === generation) {
      if (handshake.answered) { handshake.early.push(data); return; }
      handshake.answered = true;
      if (typeof data !== 'string') return handshake.reject(new ProtocolError('an envelope before the welcome'));
      try { handshake.resolve(parseReply(data)); } catch (error) { handshake.reject(error as Error); }
      return;
    }
    try {
      if (typeof data === 'string') {
        let control: any;
        try { control = JSON.parse(data); } catch { throw new ProtocolError('a text message that is not JSON'); }
        if (control?.type === 'ack' && Number.isSafeInteger(control.ack)) { this.seq.ack(control.ack); this.acknowledged(); return; }
        if (control?.type === 'bye') { this.finish({ kind: 'closed', byPeer: true }); return; }
        throw new ProtocolError(`unexpected ${String(control?.type)} after the handshake`);
      }
      const body = this.seq.accept(decodeEnvelope(data));
      this.acknowledged();
      if (body) {
        this.flush(); // acknowledge on receipt, independently of handling it
        try { this.options.onBody(Buffer.from(body)); } catch { /* a handler's failure is the handler's */ }
      }
    } catch (error) {
      // A broken rule closes the connection that carried it; the session resumes on a new one.
      this.lost(generation, `protocol error: ${(error as Error).message}`);
    }
  }

  /** The acknowledgement may have advanced: sample the round trip, wake senders, and fill the freed window. */
  private acknowledged() {
    const now = Date.now();
    let sample: number | undefined;
    while (this.written.length && this.written[0]!.seq <= this.seq.acked) {
      const { seq, at } = this.written.shift()!;
      if (seq === this.seq.acked) sample = now - at;
    }
    if (sample !== undefined) this.minRttMs = Math.min(this.minRttMs ?? Infinity, sample);
    this.settleDrains();
    this.flush();
  }

  /** Write what the broker has not had on this connection, within the in-flight window, then an acknowledgement if one is owed. Nothing waits for an acknowledgement. */
  private flush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const link = this.link;
      if (!link || this.ended) return;
      try {
        let wrote = false;
        const now = Date.now();
        for (let envelope = this.seq.next(this.flow.window); envelope; envelope = this.seq.next(this.flow.window)) {
          link.send(encodeEnvelope(envelope)); wrote = true;
          this.written.push({ seq: envelope.seq, at: now });
        }
        if (!wrote && this.seq.needsAck) link.send(JSON.stringify({ type: 'ack', ack: this.seq.markAckSent() }));
        else if (!wrote) return;
        this.lastTx = Date.now();
      } catch (error) { this.lost(this.generation, `send failed: ${(error as Error).message}`); }
    });
  }

  private tick(generation: number) {
    if (generation !== this.generation || !this.link || this.ended) return;
    const now = Date.now();
    if (now - this.lastRx >= this.timing.deadMs) return this.lost(generation, 'no traffic within the dead-connection bound');
    this.flow.observe(now, this.seq.ackedBytes, this.seq.busy, this.minRttMs);
    this.flush();
    if (this.seq.acked !== this.ackProgress.acked || !this.seq.awaitingAck) this.ackProgress = { acked: this.seq.acked, at: now };
    else if (now - this.ackProgress.at >= this.timing.deadMs) return this.lost(generation, 'no acknowledgement within the dead-connection bound');
    if (now - this.lastTx >= this.heartbeatMs) {
      try { this.link.send(JSON.stringify({ type: 'ack', ack: this.seq.markAckSent() })); this.lastTx = now; }
      catch (error) { this.lost(generation, `heartbeat failed: ${(error as Error).message}`); }
    }
  }

  private lost(generation: number, reason: string) {
    if (generation !== this.generation || this.ended) return;
    if (this.handshake?.generation === generation) { this.handshake.reject(new ConnectError(reason)); this.handshake.answered = true; return; }
    const link = this.link;
    if (!link) return;
    this.link = undefined; this.generation++;
    clearInterval(this.ticker); this.ticker = undefined;
    try { link.close(); } catch { /* already gone */ }
    this.options.onEvent?.({ kind: 'lost', reason });
    void this.reconnect();
  }

  /**
   * Reconnect with backoff until resumed, or end the session. The broker may
   * notice the loss up to the dead-connection bound later than this side, so
   * after grace plus that bound it has surely dropped the session.
   */
  private async reconnect() {
    const giveUp = Date.now() + this.graceMs + this.timing.deadMs;
    for (let attempt = 0; ; attempt++) {
      const pause = Math.min(backoffDelay(attempt, this.random(), this.timing), giveUp - Date.now());
      await new Promise<void>(done => { const timer = setTimeout(done, Math.max(0, pause)); this.wake = () => { clearTimeout(timer); done(); }; });
      this.wake = undefined;
      if (this.ended) return;
      if (Date.now() >= giveUp) return this.finish({ kind: 'expired', reason: 'grace_elapsed' });
      let connected: Connected;
      try { connected = await this.connect(this.id, this.seq.received); }
      catch (error) {
        if (this.ended) return;
        if (error instanceof ConnectError) continue;
        return this.finish({ kind: 'protocol', message: (error as Error).message });
      }
      const { link, reply } = connected;
      if (this.ended) { this.abandon(link); return; }
      if (reply.type === 'welcome' && reply.resumed && reply.session === this.id) {
        try { this.attach(connected, reply); }
        catch (error) { this.abandon(link); return this.finish({ kind: 'protocol', message: (error as Error).message }); }
        this.options.onEvent?.({ kind: 'resumed' });
        return;
      }
      this.abandon(link);
      if (reply.type === 'expired') return this.finish({ kind: 'expired', reason: reply.reason });
      if (reply.type === 'error') return this.finish({ kind: 'rejected', code: reply.code, message: reply.message });
      return this.finish({ kind: 'protocol', message: `asked to resume ${this.id}, got a welcome for ${reply.session}` });
    }
  }

  private settleDrains() {
    for (let i = this.drainWaiters.length - 1; i >= 0; i--) {
      const waiter = this.drainWaiters[i]!;
      if (this.ended || this.seq.outboxBytes <= waiter.limit) { this.drainWaiters.splice(i, 1); waiter.done(); }
    }
  }

  private finish(end: SessionEnd) {
    if (this.ended) return;
    this.ended = end;
    clearInterval(this.ticker); this.ticker = undefined;
    const link = this.link; this.link = undefined; this.generation++;
    if (link) { try { link.close(); } catch { /* already gone */ } }
    this.wake?.();
    this.settleDrains();
    this.options.onEnd(end);
  }
}
