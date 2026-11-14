/**
 * The relay's client of machine-service's broker (vm-service RP-1 to RP-15):
 * relay messages over one resumable session per lease, each operation under
 * the relay's execution ID. After a loss the session cannot resume, a new
 * session asks `query` for each call that was out: a completed or running one
 * is sent again under the same execution ID, which the broker answers from
 * its record and never runs twice; an `unknown` one stays uncertain and is
 * never sent again (docs/relay-agent-link.md §3).
 *
 * Relay protocol 2 (RP-15) makes streams resumable: an upload keeps within
 * the window beyond the relay agent's `progress`, and after `upload_incomplete`
 * or a lost session it continues with `resume` from the agent's committed
 * offset; a read cut by a lost session continues with `offset` from the
 * bytes already received.
 */
import { createHash, randomUUID, X509Certificate, type Hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { connect as tlsConnect, rootCertificates, type ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import WebSocket from 'ws';
import { brokerRoute, sessionGraceMs, type BrokerRoute } from './config.js';

/** The grace period this client asks for: its option, else the setting, else the broker's. */
function graceMs(options: RelayClientOptions): number | undefined { return options.graceMs ?? sessionGraceMs(); }
import { MAX_BUFFERED, MAX_MESSAGE, ResumableSession, type Dial, type SessionEnd, type Timing } from './relay-session.js';

/** The most data one chunk carries: 1 MiB less 4 KiB (RP-4, RP-12). */
export const MAX_CHUNK = MAX_MESSAGE - 4096;
/** The relay protocol this client speaks, named in its hello and the broker's `ready` (RP-3, RP-12). */
export const RELAY_PROTOCOL = 2;
/** The most bytes of an upload sent beyond the relay agent's last `progress` (RP-15). */
export const UPLOAD_WINDOW = 32 * 1024 * 1024;
/** Session bytes unacknowledged before the next chunk waits, under a broker of protocol 1. */
/** How many times an upload continues after `upload_incomplete` before the call fails. */
const MAX_CONTINUATIONS = 20;
const CHUNK_TAG = 0x01;
/** An exec's output kept in memory: its tail; the whole stream is still hashed. */
const OUTPUT_KEPT = 16 * 1024 * 1024;

/** The acquisition answer's `relay` (RP-11). */
export interface RelayGrant { url: string; credential: string; ca_sha256: string; ca_pem: string }

export type Op =
  | { exec: { command: string; stdin: boolean; timeout_s: number } }
  | { script: { timeout_s: number } }
  | { write: { path: string; name: string; mode: number | null } }
  | { read: { path: string } }
  | { write_tree: { path: string; name: string } }
  | { read_tree: { path: string } }
  | { cancel: { target: string } }
  | 'status';
export type OpKind = 'exec' | 'script' | 'write' | 'read' | 'write_tree' | 'read_tree' | 'cancel' | 'status';
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
const uploads = (kind: OpKind | 'query') => kind === 'exec' || kind === 'script' || kind === 'write' || kind === 'write_tree';
const streams = (kind: OpKind | 'query') => kind === 'exec' || kind === 'script' || kind === 'read' || kind === 'read_tree';
const reads = (kind: OpKind | 'query') => kind === 'read' || kind === 'read_tree';

/** An upload's stream, read from any offset, so it continues after a loss without holding it in memory (RP-15). */
export interface UploadSource {
  readonly size: number;
  /** The SHA-256 of the whole stream, lower-case hex. */
  readonly sha256: string;
  read(offset: number, length: number): Promise<Buffer>;
}
/** An upload from bytes in memory. */
export function bufferSource(bytes: Buffer): UploadSource {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), read: async (offset, length) => bytes.subarray(offset, offset + length) };
}
/** An upload from a file, hashed once now; the file must not change until the upload ends. */
export async function fileSource(path: string): Promise<UploadSource> {
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_CHUNK);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
  } finally { await file.close(); }
  return {
    size, sha256: hash.digest('hex'),
    read: async (offset, length) => {
      const reader = await open(path, 'r');
      try {
        const out = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await reader.read(out, filled, length - filled, offset + filled);
          if (!bytesRead) throw new Error(`${path} ended before ${offset + length} bytes; it changed during the upload`);
          filled += bytesRead;
        }
        return out;
      } finally { await reader.close(); }
    },
  };
}

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
/** One line on standard error, which an MCP server keeps for its log. */
function stderrLine(line: string) { process.stderr.write(`${line}\n`); }

export function webSocketDial(url: string, caPem: string, handshakeMs = 10000, route: BrokerRoute = {}): Dial {
  const ca = [...rootCertificates, caPem, ...(route.caPem ? [route.caPem] : [])];
  // The route's one name connects to its address, and port when given, keeping the name as the TLS server name (curl's --resolve, --connect-to).
  const to = route.resolve;
  const createConnection = to ? (options: TlsConnectionOptions) => {
    if (String(options.host).toLowerCase() !== to.host) return tlsConnect({ ...options, path: undefined });
    return tlsConnect({ ...options, path: undefined, servername: to.host, host: to.address, port: to.port ?? options.port });
  } : undefined;
  return handlers => new Promise((resolve, reject) => {
    // ws hands its options to tls.connect, which takes the ALPN list.
    const tlsOptions: WebSocket.ClientOptions & { ALPNProtocols: string[] } = { ca, ...(createConnection ? { createConnection: createConnection as unknown as WebSocket.ClientOptions['createConnection'] } : {}), ALPNProtocols: ['http/1.1'], maxPayload: MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: handshakeMs, followRedirects: false };
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
  upload: UploadSource;
  sink?: Sink;
  hash: Hash; size: number; kept: Buffer[]; keptBytes: number;
  end?: Digest;
  number?: number;
  /** The `end` of the upload went into the session's buffer. */
  committedSend: boolean;
  /** The next call continues the upload the relay agent holds (RP-15). */
  resume: boolean;
  /** The first byte of the answer's stream to ask for: a read continued after a loss (RP-15). */
  offset: number;
  /** The relay agent's latest committed offset for this attempt. */
  committed?: number;
  /** How many times the upload continued. */
  continuations: number;
  /** Waiters for the next `progress`, the end of the call or of its session. */
  wake: Array<() => void>;
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
  /** The grace period to ask the broker for; read from MCP_RELAY_SESSION_GRACE_MS when absent. */
  graceMs?: number;
  /** How the default dial reaches the broker; read from MCP_RELAY_BROKER_RESOLVE and MCP_RELAY_BROKER_CA when absent. */
  route?: BrokerRoute;
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
  async run(op: Op, input: Buffer | UploadSource = Buffer.alloc(0), options: CallOptions = {}): Promise<CallAnswer> {
    options.signal?.throwIfAborted();
    const kind = kindOf(op);
    const upload = Buffer.isBuffer(input) ? bufferSource(input) : input;
    if (!uploads(kind) && upload.size) throw new TypeError(`${kind} takes no upload`);
    let executionId = options.executionId ?? randomUUID();
    if (!executionId || Buffer.byteLength(executionId) > 256) throw new TypeError('an execution ID has 1 to 256 bytes');
    for (let attempt = 0; ; attempt++) {
      const answer = await this.once(op, upload, executionId, options);
      // A replayed read has no bytes, and a cut one does not match its end: read again under a new execution ID (RP-7).
      if (reads(kind) && 'read' in answer.outcome && !this.streamMatches(answer) && attempt < 3) { options.sink?.reset(); executionId = randomUUID(); continue; }
      return answer;
    }
  }
  /** What the broker or the relay agent knows of an execution ID (RP-7). */
  async query(executionId: string, options: Pick<CallOptions, 'signal' | 'timeoutMs'> = {}): Promise<ExecutionState> {
    const call = this.track(executionId, 'status', 'query', bufferSource(Buffer.alloc(0)));
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

  private async once(op: Op, upload: UploadSource, executionId: string, options: CallOptions): Promise<CallAnswer> {
    const kind = kindOf(op);
    const call = this.track(executionId, op, kind, upload, options.sink);
    const { result } = await this.dispatch(call, options);
    // A read continued after a loss ran under a new execution ID.
    const id = call.executionId;
    const stream = streams(kind) && (call.end || call.size) ? { size: call.size, sha256: call.hash.copy().digest('hex') } : undefined;
    if (streams(kind) && call.end && stream && (call.end.size !== stream.size || call.end.sha256 !== stream.sha256)) {
      if (!reads(kind)) throw new RelayUncertainError(id, `the output of execution ${id} does not match its end`);
      return { executionId: id, replayed: result!.replayed, outcome: result!.outcome, output: Buffer.alloc(0) };
    }
    const exit = (result!.outcome as { exit?: { output: Digest } }).exit;
    if (exit && stream && (exit.output.size !== stream.size || exit.output.sha256 !== stream.sha256)) throw new RelayUncertainError(id, `the output of execution ${id} does not match its outcome`);
    return { executionId: id, replayed: result!.replayed, outcome: result!.outcome, output: Buffer.concat(call.kept), ...(stream && call.end ? { stream } : {}) };
  }

  private track(executionId: string, op: Op, kind: OpKind | 'query', upload: UploadSource, sink?: Sink): Call {
    return { executionId, op, kind, upload, sink, hash: createHash('sha256'), size: 0, kept: [], keptBytes: 0, committedSend: false, resume: false, offset: 0, continuations: 0, wake: [], settle: () => {}, fail: () => {}, done: false };
  }
  private reset(call: Call) {
    call.hash = createHash('sha256'); call.size = 0; call.kept = []; call.keptBytes = 0; call.end = undefined; call.offset = 0; call.sink?.reset();
  }
  /** Wake whoever waits on the call's progress. */
  private wakeAll(call: Call) { const wake = call.wake; call.wake = []; for (const go of wake) go(); }
  /** Wait for the call's next progress, its end, or a second, whichever comes first. */
  private nextProgress(call: Call): Promise<void> {
    return new Promise(done => { const timer = setTimeout(done, 1000); timer.unref?.(); call.wake.push(() => { clearTimeout(timer); done(); }); });
  }

  /** Send a call in the current session and wait for its last message, through any recovery. */
  private dispatch(call: Call, options: Pick<CallOptions, 'signal' | 'timeoutMs'>): Promise<{ result?: { replayed: boolean; outcome: Outcome }; state?: ExecutionState }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { call.done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      call.settle = answer => { if (call.done) return; finish(); this.wakeAll(call); resolve(answer); };
      call.fail = error => { if (call.done) return; finish(); this.wakeAll(call); reject(error); };
      const abort = () => {
        const reason = options.signal!.reason;
        // A cancelled operation is stopped in the guest when it may run there (RP-4's cancel).
        if (call.kind !== 'query' && !reads(call.kind) && call.kind !== 'status') void this.cancel(call.executionId);
        call.fail(reason instanceof Error ? reason : new Error(String(reason)));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => call.fail(call.kind === 'query' || reads(call.kind) || call.kind === 'status'
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
      dial: this.options.dial ?? webSocketDial(this.grant.url, this.grant.ca_pem, this.options.timing?.handshakeMs, this.options.route ?? brokerRoute()),
      credential: this.grant.credential,
      attributes: { role: 'client', protocol: RELAY_PROTOCOL, ...(graceMs(this.options) !== undefined ? { grace_ms: graceMs(this.options) } : {}) },
      ...(this.options.timing ? { timing: this.options.timing } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      onBody: body => this.receive(handle, body, readyResolve),
      onEnd: end => this.ended(handle, end),
      // Every loss and resume goes to the log, by default the server's standard error, so an operator or a test sees the link's history.
      onEvent: event => (this.options.log ?? stderrLine)(`relay: session ${event.kind}${event.reason ? `: ${event.reason}` : ''}`),
    });
    this.sessions++;
    if (!handle.session.ended && !this.closed) this.active = handle;
    return handle;
  }

  /**
   * Put a call into the current session: its `call`, its upload as chunks
   * within the window beyond the relay agent's progress, its `end`. A call
   * that resumes waits for the agent's committed offset and sends from there
   * (RP-15).
   */
  private async send(call: Call) {
    let handle = await this.current();
    // A session that ended while this call waited for it is replaced by a new one.
    while (handle.session.ended) {
      if (this.active === handle || !this.active) { this.active = undefined; this.handle = undefined; }
      handle = await this.current();
    }
    if (call.done) return;
    const number = handle.next++;
    call.number = number; call.committedSend = false; call.committed = undefined;
    handle.calls.set(number, call);
    const session = handle.session;
    if (call.kind === 'query') { session.send(encodeControl('query', { call: number, execution: call.executionId })); return; }
    // A broker of protocol 1 knows neither `resume` nor `offset`, and reports no progress.
    const v2 = (await handle.ready).protocol >= 2;
    const stale = () => call.done || session.ended || handle.calls.get(number) !== call;
    if (stale()) return;
    const resume = v2 && call.resume && uploads(call.kind);
    const offset = v2 ? call.offset : 0;
    if (!v2 && call.offset) this.reset(call);
    session.send(encodeControl('call', { call: number, execution: call.executionId, op: call.op, ...(resume ? { resume: true } : {}), ...(offset ? { offset } : {}) }));
    if (!uploads(call.kind)) { call.committedSend = true; return; }
    const { upload } = call;
    let at = 0;
    if (resume) {
      while (call.committed === undefined) { if (stale()) return; await this.nextProgress(call); }
      at = Math.min(call.committed, upload.size);
    }
    const from = at;
    while (at < upload.size) {
      if (v2) while (!stale() && at - (call.committed ?? from) >= UPLOAD_WINDOW) await this.nextProgress(call);
      else await session.drained(MAX_BUFFERED); // protocol 1: the replay buffer; the session's window bounds what is in flight
      if (stale()) return;
      const length = Math.min(MAX_CHUNK, upload.size - at);
      const data = await upload.read(at, length);
      if (stale()) return;
      session.send(encodeChunk(number, data));
      at += length;
    }
    if (stale()) return;
    session.send(encodeControl('end', { call: number, execution: call.executionId, size: upload.size, sha256: upload.sha256 }));
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
      case 'progress':
        if (!call || value.execution !== call.executionId || typeof value.committed !== 'number') return;
        call.committed = Math.max(call.committed ?? 0, value.committed);
        this.wakeAll(call);
        return;
      case 'result': {
        if (!call || value.execution !== call.executionId) return;
        handle.calls.delete(value.call);
        const failed = (value.outcome as { failed?: { code: string; committed: boolean } }).failed;
        // The relay agent lost part of the upload, or its session ended: continue from its committed offset (RP-15).
        if (failed?.code === 'upload_incomplete' && !failed.committed && uploads(call.kind) && call.continuations < MAX_CONTINUATIONS) {
          call.continuations++; call.resume = true;
          this.options.log?.(`relay: execution ${call.executionId} continues from the relay agent's committed offset`);
          this.wakeAll(call);
          void this.send(call).catch(error => call.fail(error));
          return;
        }
        call.settle({ result: { replayed: !!value.replayed, outcome: value.outcome } });
        return;
      }
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
      this.wakeAll(call);
      if (final) {
        call.fail(this.mayHaveRun(call) ? new RelayUncertainError(call.executionId, `relay: ${why}`) : new Error(`relay: ${why}; the operation never reached its commit point`));
        continue;
      }
      void this.recover(call).catch(error => call.fail(error));
    }
  }

  /** Whether a call may have passed its commit point: its upload's `end`, or for cancel its `call`, went out. */
  private mayHaveRun(call: Call) {
    if (call.kind === 'query' || reads(call.kind) || call.kind === 'status' || call.number === undefined) return false;
    return call.committedSend || !uploads(call.kind);
  }

  /** After an unresumable loss: query, then attach to a known execution, or report it uncertain. */
  private async recover(call: Call) {
    if (call.done) return;
    // A read continues under a new execution ID from the bytes already received (RP-15).
    if (reads(call.kind) && !call.end) { call.executionId = randomUUID(); call.offset = call.size; return this.send(call); }
    this.reset(call);
    // An upload whose end never went out never ran: it continues from the relay agent's committed offset.
    if (uploads(call.kind) && !call.committedSend && call.number !== undefined) { call.resume = true; return this.send(call); }
    // A read or a status changes nothing; a query only asks.
    if (!this.mayHaveRun(call)) { if (reads(call.kind)) call.executionId = randomUUID(); return this.send(call); }
    let state: ExecutionState;
    try { state = await this.query(call.executionId); }
    catch (error) { throw new RelayUncertainError(call.executionId, `the session was lost and the execution could not be queried: ${(error as Error).message}`, { cause: error }); }
    if (state === 'unknown') throw new RelayUncertainError(call.executionId, 'the session was lost and neither the broker nor the relay agent has a record of the execution');
    if (call.done) return;
    // Completed or running: the same call under the same execution ID takes the recorded answer and never runs again;
    // with `resume`, a running upload is not started again either.
    call.resume = true;
    return this.send(call);
  }
}
