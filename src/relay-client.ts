/**
 * The relay's client of machine-service's broker (vm-service RP-1 to RP-12):
 * relay messages over one resumable session per lease, each operation under
 * the relay's execution ID. After a loss the session cannot resume, a new
 * session asks `query` for each call that was out: a completed or running one
 * is sent again under the same execution ID, which the broker answers from
 * its record and never runs twice; an `unknown` one stays uncertain and is
 * never sent again (docs/relay-agent-link.md §3).
 */
import { createHash, randomUUID, X509Certificate, type Hash } from 'node:crypto';
import { isIP } from 'node:net';
import { rootCertificates } from 'node:tls';
import WebSocket from 'ws';
import { MAX_MESSAGE, ResumableSession, type Dial, type SessionEnd, type Timing } from './relay-session.js';

/** The most data one chunk carries: 1 MiB less 4 KiB (RP-4, RP-12). */
export const MAX_CHUNK = MAX_MESSAGE - 4096;
/** The largest upload (RP-5). */
export const MAX_UPLOAD = 256 * 1024 * 1024;
/** The relay protocol's version in `ready` (RP-12). */
export const RELAY_PROTOCOL = 1;
const CHUNK_TAG = 0x01;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
/** Upload bytes unacknowledged before the next chunk waits. */
const UPLOAD_WINDOW = 8 * MAX_MESSAGE;
/** An exec's output kept in memory: its tail; the whole stream is still hashed. */
const OUTPUT_KEPT = 16 * 1024 * 1024;

/** The acquisition answer's `relay` (RP-11). */
export interface RelayGrant { url: string; credential: string; ca_sha256: string; ca_pem: string }

export type Op =
  | { exec: { command: string; stdin: boolean; timeout_s: number } }
  | { script: { timeout_s: number } }
  | { write: { path: string; name: string; mode: number | null } }
  | { read: { path: string } }
  | { cancel: { target: string } }
  | 'status';
export type OpKind = 'exec' | 'script' | 'write' | 'read' | 'cancel' | 'status';
export interface Digest { size: number; sha256: string }
export type Outcome =
  | { exit: { rc: number | null; signal: number | null; timed_out: boolean; cancelled: boolean; output: Digest } }
  | { written: Digest }
  | { read: Digest }
  | { cancel: { target: string; found: 'signalled' | 'discarded' | 'completed' | 'unknown' } }
  | { status: { protocol: number; build: string; os: string; running: string[] } }
  | { failed: { code: string; message: string; committed: boolean } }
  | { interrupted: { message: string } };
export type ExecutionState = { completed: { op: OpKind; outcome: Outcome } } | { running: { op: OpKind } } | 'unknown';
export interface Ready { protocol: number; lease: string; agent: { os: string; arch: string; build: string; protocol: number } | null }

export type RelayMessage =
  | { chunk: { call: number; data: Buffer } }
  | { name: string; value: any };

export const kindOf = (op: Op): OpKind => typeof op === 'string' ? op : Object.keys(op)[0] as OpKind;
const uploads = (kind: OpKind) => kind === 'exec' || kind === 'script' || kind === 'write';
const streams = (kind: OpKind) => kind === 'exec' || kind === 'script' || kind === 'read';

export function encodeChunk(call: number, data: Buffer): Buffer {
  if (data.length > MAX_CHUNK) throw new RangeError(`a chunk of ${data.length} bytes exceeds ${MAX_CHUNK}`);
  const out = Buffer.allocUnsafe(9 + data.length);
  out[0] = CHUNK_TAG; out.writeBigUInt64BE(BigInt(call), 1); data.copy(out, 9);
  return out;
}
export const encodeControl = (name: string, value: unknown): Buffer => Buffer.from(JSON.stringify(value === undefined ? name : { [name]: value }));
/** One relay message: a binary chunk, or a control message named by its one key or its bare string (RP-4). */
export function decodeMessage(body: Buffer): RelayMessage {
  if (body[0] === CHUNK_TAG) {
    if (body.length < 9) throw new Error(`a chunk of ${body.length} bytes is shorter than its header`);
    return { chunk: { call: Number(body.readBigUInt64BE(1)), data: body.subarray(9) } };
  }
  const value = JSON.parse(body.toString('utf8'));
  if (typeof value === 'string') return { name: value, value: undefined };
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1) { const [name] = Object.keys(value); return { name: name!, value: value[name!] }; }
  throw new Error('not a relay message');
}

/** The lower-case hexadecimal SHA-256 of a PEM certificate's DER encoding, as `relay_ca_sha256` names it (RP-1). */
export function caFingerprint(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}
/**
 * Whether a grant can be used: a `wss://` URL at `/relay` (or `ws://` to a
 * loopback host), a credential, and an authority whose certificate hashes to
 * the fingerprint that the instance advertises.
 */
export function checkGrant(grant: unknown, advertised: { relay_url?: unknown; relay_ca_sha256?: unknown }): string | undefined {
  const g = grant as Partial<RelayGrant> | undefined;
  if (!g || typeof g.url !== 'string' || typeof g.credential !== 'string' || !g.credential || typeof g.ca_sha256 !== 'string' || typeof g.ca_pem !== 'string') return 'the lease carries no complete relay grant';
  if (typeof advertised.relay_url !== 'string' || typeof advertised.relay_ca_sha256 !== 'string') return 'the instance does not advertise relay_url and relay_ca_sha256';
  if (advertised.relay_ca_sha256.toLowerCase() !== g.ca_sha256.toLowerCase()) return 'the grant names another authority than the instance advertises';
  let fingerprint: string;
  try { fingerprint = caFingerprint(g.ca_pem); } catch { return 'the grant\'s authority is not a PEM certificate'; }
  if (fingerprint !== g.ca_sha256.toLowerCase()) return 'the grant\'s authority does not hash to its fingerprint';
  let url: URL;
  try { url = new URL(g.url); } catch { return 'the grant\'s URL does not parse'; }
  if (url.pathname !== '/relay' || url.username || url.password || url.search || url.hash) return 'the grant\'s URL is not a broker URL at /relay';
  if (url.protocol === 'ws:' && !loopback(url.hostname)) return 'plain ws:// is accepted only to a loopback host';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return 'the grant\'s URL is not ws:// or wss://';
  return undefined;
}
function loopback(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * Dial the broker over TLS with the `ws` library: the URL's host name is
 * resolved on every attempt and sent as the TLS server name, ALPN offers
 * only `http/1.1`, the public roots and the instance's authority are
 * trusted, and no message above 1 MiB is accepted (RP-1).
 */
export function webSocketDial(url: string, caPem: string, handshakeMs = 10000): Dial {
  const ca = [...rootCertificates, caPem];
  return handlers => new Promise((resolve, reject) => {
    // ws hands its options to tls.connect, which takes the ALPN list.
    const tlsOptions: WebSocket.ClientOptions & { ALPNProtocols: string[] } = { ca, ALPNProtocols: ['http/1.1'], maxPayload: MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: handshakeMs, followRedirects: false };
    const socket = new WebSocket(url, [], tlsOptions);
    let open = false;
    socket.on('open', () => {
      open = true;
      // A close sends what was queued (such as a bye) and a close frame; a peer that does not answer within a second is cut.
      const close = () => { if (socket.readyState >= WebSocket.CLOSING) return; socket.close(); setTimeout(() => socket.terminate(), 1000).unref(); };
      resolve({ send: data => socket.send(data, { binary: typeof data !== 'string' }), close });
    });
    socket.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      handlers.message(binary ? bytes : bytes.toString('utf8'));
    });
    socket.on('error', error => { if (!open) reject(error); });
    socket.on('close', (code, reason) => { if (!open) reject(new Error(`closed before opening (${code})`)); else handlers.closed(`closed (${code}${reason.length ? `: ${reason}` : ''})`); });
  });
}

/** An operation whose effect is uncertain: it may have run, and it is never sent again. */
export class RelayUncertainError extends Error {
  constructor(readonly executionId: string, message: string, options?: ErrorOptions) { super(`${message}; whether execution ${executionId} took effect is uncertain, and it is not sent again`, options); this.name = 'RelayUncertainError'; }
}
/** An operation the broker or the relay agent answered with `failed`. */
export class RelayFailedError extends Error {
  constructor(readonly executionId: string, readonly code: string, readonly detail: string, readonly committed: boolean) {
    super(`relay: ${code}: ${detail}${committed ? `; execution ${executionId} passed its commit point, so whether it took effect is uncertain` : ''}`);
    this.name = 'RelayFailedError';
  }
}

/** Where a call's streamed bytes go. `reset` starts the stream again when the call is sent anew. */
export interface Sink { write(data: Buffer): void; reset(): void }
export interface CallOptions {
  executionId?: string;
  signal?: AbortSignal;
  /** No outcome within this long makes the call uncertain. */
  timeoutMs?: number;
  /** The stream goes here instead of being kept. */
  sink?: Sink;
}
export interface CallAnswer {
  executionId: string;
  replayed: boolean;
  outcome: Outcome;
  /** An exec's or script's output, its last 16 MiB at most; empty with a sink. */
  output: Buffer;
  /** The stream's size and SHA-256 as received and as its end stated. */
  stream?: Digest;
}

interface Call {
  executionId: string;
  op: Op;
  kind: OpKind | 'query';
  upload: Buffer;
  sink?: Sink;
  hash: Hash; size: number; kept: Buffer[]; keptBytes: number;
  end?: Digest;
  number?: number;
  /** The `end` of the upload went into the session's buffer. */
  committedSend: boolean;
  /** A read whose execution IDs so far; a re-read takes a new one. */
  settle: (answer: { result?: { replayed: boolean; outcome: Outcome }; state?: ExecutionState }) => void;
  fail: (error: Error) => void;
  done: boolean;
}
interface Handle {
  session: ResumableSession;
  ready: Promise<Ready>;
  readyInfo?: Ready;
  calls: Map<number, Call>;
  next: number;
  revoked?: string;
}

export interface RelayClientOptions {
  dial?: Dial;
  timing?: Partial<Timing>;
  random?: () => number;
  log?: (line: string) => void;
}

/** One lease's link to its relay agent through the broker. */
export class RelayClient {
  private handle?: Promise<Handle>;
  /** The open session's handle, once open; cleared the moment its session ends. */
  private active?: Handle;
  private closed = false;
  /** How many sessions this client opened; tests and logs read it. */
  sessions = 0;
  constructor(readonly grant: RelayGrant, private readonly options: RelayClientOptions = {}) {}

  /** The relay agent's description from the current session's `ready`. */
  async ready(): Promise<Ready> { return (await this.current()).ready; }

  /** Run one operation and wait for its result. A `failed` or `interrupted` outcome is returned, not thrown. */
  async run(op: Op, upload: Buffer = Buffer.alloc(0), options: CallOptions = {}): Promise<CallAnswer> {
    options.signal?.throwIfAborted();
    const kind = kindOf(op);
    if (!uploads(kind) && upload.length) throw new TypeError(`${kind} takes no upload`);
    if (upload.length > MAX_UPLOAD) throw new RangeError(`an upload of ${upload.length} bytes exceeds 256 MiB`);
    let executionId = options.executionId ?? randomUUID();
    if (!executionId || Buffer.byteLength(executionId) > 256) throw new TypeError('an execution ID has 1 to 256 bytes');
    for (let reads = 0; ; reads++) {
      const answer = await this.once(op, upload, executionId, options);
      // A replayed read has no bytes, and a cut one does not match its end: read again under a new execution ID (RP-7).
      if (kind === 'read' && 'read' in answer.outcome && !this.streamMatches(answer) && reads < 3) { options.sink?.reset(); executionId = randomUUID(); continue; }
      return answer;
    }
  }
  /** What the broker or the relay agent knows of an execution ID (RP-7). */
  async query(executionId: string, options: Pick<CallOptions, 'signal' | 'timeoutMs'> = {}): Promise<ExecutionState> {
    const call = this.track(executionId, 'status', 'query', Buffer.alloc(0));
    return (await this.dispatch(call, options)).state!;
  }
  close() {
    this.closed = true;
    const handle = this.handle; this.handle = undefined; this.active = undefined;
    void handle?.then(h => h.session.close(), () => {});
  }

  private streamMatches(answer: CallAnswer) {
    const outcome = answer.outcome as { read?: Digest };
    return !!answer.stream && !!outcome.read && answer.stream.size === outcome.read.size && answer.stream.sha256 === outcome.read.sha256;
  }

  private async once(op: Op, upload: Buffer, executionId: string, options: CallOptions): Promise<CallAnswer> {
    const kind = kindOf(op);
    const call = this.track(executionId, op, kind, upload, options.sink);
    const { result } = await this.dispatch(call, options);
    const stream = streams(kind) && (call.end || call.size) ? { size: call.size, sha256: call.hash.copy().digest('hex') } : undefined;
    if (streams(kind) && call.end && stream && (call.end.size !== stream.size || call.end.sha256 !== stream.sha256)) {
      if (kind !== 'read') throw new RelayUncertainError(executionId, `the output of execution ${executionId} does not match its end`);
      return { executionId, replayed: result!.replayed, outcome: result!.outcome, output: Buffer.alloc(0) };
    }
    const exit = (result!.outcome as { exit?: { output: Digest } }).exit;
    if (exit && stream && (exit.output.size !== stream.size || exit.output.sha256 !== stream.sha256)) throw new RelayUncertainError(executionId, `the output of execution ${executionId} does not match its outcome`);
    return { executionId, replayed: result!.replayed, outcome: result!.outcome, output: Buffer.concat(call.kept), ...(stream && call.end ? { stream } : {}) };
  }

  private track(executionId: string, op: Op, kind: OpKind | 'query', upload: Buffer, sink?: Sink): Call {
    return { executionId, op, kind, upload, sink, hash: createHash('sha256'), size: 0, kept: [], keptBytes: 0, committedSend: false, settle: () => {}, fail: () => {}, done: false };
  }
  private reset(call: Call) {
    call.hash = createHash('sha256'); call.size = 0; call.kept = []; call.keptBytes = 0; call.end = undefined; call.sink?.reset();
  }

  /** Send a call in the current session and wait for its last message, through any recovery. */
  private dispatch(call: Call, options: Pick<CallOptions, 'signal' | 'timeoutMs'>): Promise<{ result?: { replayed: boolean; outcome: Outcome }; state?: ExecutionState }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { call.done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      call.settle = answer => { if (call.done) return; finish(); resolve(answer); };
      call.fail = error => { if (call.done) return; finish(); reject(error); };
      const abort = () => {
        const reason = options.signal!.reason;
        // A cancelled operation is stopped in the guest when it may run there (RP-4's cancel).
        if (call.kind !== 'query' && call.kind !== 'read' && call.kind !== 'status') void this.cancel(call.executionId);
        call.fail(reason instanceof Error ? reason : new Error(String(reason)));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => call.fail(call.kind === 'query' || call.kind === 'read' || call.kind === 'status'
        ? new Error(`relay: no answer for execution ${call.executionId} within ${options.timeoutMs} ms`)
        : new RelayUncertainError(call.executionId, `no outcome within ${options.timeoutMs} ms; it may still run, and query tells it later`)), options.timeoutMs);
      this.send(call).catch(error => call.fail(error));
    });
  }

  private async cancel(target: string) {
    try { await this.run({ cancel: { target } }, Buffer.alloc(0), { timeoutMs: 30000 }); }
    catch (error) { this.options.log?.(`relay: cancelling ${target} failed: ${String(error)}`); }
  }

  private current(): Promise<Handle> {
    if (this.closed) return Promise.reject(new Error('the relay link is closed'));
    if (!this.handle) {
      const opening = this.openSession();
      this.handle = opening;
      opening.catch(() => { if (this.handle === opening) this.handle = undefined; });
    }
    return this.handle;
  }

  private async openSession(): Promise<Handle> {
    let readyResolve!: (ready: Ready) => void;
    const ready = new Promise<Ready>(done => { readyResolve = done; });
    // The handle exists before the session: the first bodies may arrive while it opens.
    const handle: Handle = { session: undefined as unknown as ResumableSession, ready, calls: new Map(), next: 1 };
    handle.session = await ResumableSession.open({
      dial: this.options.dial ?? webSocketDial(this.grant.url, this.grant.ca_pem, this.options.timing?.handshakeMs),
      credential: this.grant.credential,
      attributes: { role: 'client' },
      ...(this.options.timing ? { timing: this.options.timing } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      onBody: body => this.receive(handle, body, readyResolve),
      onEnd: end => this.ended(handle, end),
      onEvent: event => this.options.log?.(`relay: session ${event.kind}${event.reason ? `: ${event.reason}` : ''}`),
    });
    this.sessions++;
    if (!handle.session.ended && !this.closed) this.active = handle;
    return handle;
  }

  /** Put a call into the current session: its `call`, its upload as chunks, its `end`. */
  private async send(call: Call) {
    let handle = await this.current();
    // A session that ended while this call waited for it is replaced by a new one.
    while (handle.session.ended) {
      if (this.active === handle || !this.active) { this.active = undefined; this.handle = undefined; }
      handle = await this.current();
    }
    if (call.done) return;
    const number = handle.next++;
    call.number = number; call.committedSend = false;
    handle.calls.set(number, call);
    const session = handle.session;
    if (call.kind === 'query') { session.send(encodeControl('query', { call: number, execution: call.executionId })); return; }
    session.send(encodeControl('call', { call: number, execution: call.executionId, op: call.op }));
    if (!uploads(call.kind as OpKind)) { call.committedSend = true; return; }
    for (let at = 0; at < call.upload.length; at += MAX_CHUNK) {
      await session.drained(UPLOAD_WINDOW);
      if (session.ended || handle.calls.get(number) !== call) return;
      session.send(encodeChunk(number, call.upload.subarray(at, at + MAX_CHUNK)));
    }
    if (session.ended || handle.calls.get(number) !== call) return;
    const sha256 = call.upload.length ? createHash('sha256').update(call.upload).digest('hex') : EMPTY_SHA256;
    session.send(encodeControl('end', { call: number, execution: call.executionId, size: call.upload.length, sha256 }));
    call.committedSend = true;
  }

  private receive(handle: Handle, body: Buffer, readyResolve: (ready: Ready) => void) {
    let message: RelayMessage;
    try { message = decodeMessage(body); }
    catch (error) { this.options.log?.(`relay: ignored a body that is not a relay message: ${String(error)}`); return; }
    if ('chunk' in message) {
      const call = handle.calls.get(message.chunk.call);
      if (!call || call.done) return;
      const data = Buffer.from(message.chunk.data);
      call.hash.update(data); call.size += data.length;
      if (call.sink) { call.sink.write(data); return; }
      call.kept.push(data); call.keptBytes += data.length;
      while (call.keptBytes > OUTPUT_KEPT && call.kept.length > 1) call.keptBytes -= call.kept.shift()!.length;
      return;
    }
    const { name, value } = message;
    const call = typeof value?.call === 'number' ? handle.calls.get(value.call) : undefined;
    switch (name) {
      case 'ready': handle.readyInfo = value; readyResolve(value); return;
      case 'pending': this.options.log?.(`relay: execution ${value?.execution} waits: ${value?.code}: ${value?.message} (up to ${value?.wait_ms} ms)`); return;
      case 'end': if (call && value.execution === call.executionId) call.end = { size: value.size, sha256: value.sha256 }; return;
      case 'result':
        if (!call || value.execution !== call.executionId) return;
        handle.calls.delete(value.call);
        call.settle({ result: { replayed: !!value.replayed, outcome: value.outcome } });
        return;
      case 'query_result':
        if (!call || value.execution !== call.executionId) return;
        handle.calls.delete(value.call);
        call.settle({ state: value.state });
        return;
      case 'revoked': handle.revoked = String(value?.reason ?? 'released'); return;
      default: return; // A client ignores message names it does not know (RP-4).
    }
  }

  /**
   * The session ended for good. A local close or a refusal fails every call
   * that was out; any other end opens a new session and recovers each call
   * from the records (RP-7).
   */
  private ended(handle: Handle | undefined, end: SessionEnd) {
    if (!handle) return;
    if (this.active === handle) { this.active = undefined; this.handle = undefined; }
    const calls = [...handle.calls.values()].filter(call => !call.done);
    handle.calls.clear();
    const why = end.kind === 'rejected' ? `the broker refused the session (${end.code}: ${end.message})`
      : end.kind === 'closed' ? (handle.revoked ? `the lease was ${handle.revoked}` : end.byPeer ? 'the broker closed the session' : 'the relay link was closed')
      : end.kind === 'expired' ? `the session expired (${end.reason})` : `the session broke (${end.message})`;
    this.options.log?.(`relay: ${why}`);
    const final = this.closed || end.kind === 'rejected' || end.kind === 'closed';
    for (const call of calls) {
      if (final) {
        call.fail(this.mayHaveRun(call) ? new RelayUncertainError(call.executionId, `relay: ${why}`) : new Error(`relay: ${why}; the operation never reached its commit point`));
        continue;
      }
      void this.recover(call).catch(error => call.fail(error));
    }
  }

  /** Whether a call may have passed its commit point: its upload's `end`, or for cancel its `call`, went out. */
  private mayHaveRun(call: Call) {
    if (call.kind === 'query' || call.kind === 'read' || call.kind === 'status' || call.number === undefined) return false;
    return call.committedSend || !uploads(call.kind);
  }

  /** After an unresumable loss: query, then attach to a known execution, or report it uncertain. */
  private async recover(call: Call) {
    if (call.done) return;
    this.reset(call);
    // A read or a status changes nothing; a query only asks; an upload whose end never went out never ran.
    if (!this.mayHaveRun(call)) { if (call.kind === 'read') call.executionId = randomUUID(); return this.send(call); }
    let state: ExecutionState;
    try { state = await this.query(call.executionId); }
    catch (error) { throw new RelayUncertainError(call.executionId, `the session was lost and the execution could not be queried: ${(error as Error).message}`, { cause: error }); }
    if (state === 'unknown') throw new RelayUncertainError(call.executionId, 'the session was lost and neither the broker nor the relay agent has a record of the execution');
    if (call.done) return;
    // Completed or running: the same call under the same execution ID takes the recorded answer and never runs again.
    return this.send(call);
  }
}
