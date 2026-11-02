/**
 * An in-process stand-in for machine-service's broker, for the session and
 * relay-client unit tests: the server side of the remote session (vm-service
 * RP-2) over a fake connection, with faults a test switches on (a dropped
 * connection, a duplicated or reordered envelope, a blackhole, refused
 * connections, a forgotten session), and an optional relay layer (RP-4 to
 * RP-7) whose execution records answer replays and queries.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SeqState, decodeEnvelope, encodeEnvelope, type Dial, type Link, type LinkHandlers } from '../src/relay-session.js';
import { decodeMessage, encodeChunk, encodeControl, MAX_CHUNK, type Op, type Outcome } from '../src/relay-client.js';

const later = (fn: () => void) => setImmediate(fn);

interface ServerSession { id: string; seq: SeqState; conn?: Conn; principal: string; app: (body: Buffer) => void }
class Conn {
  open = true;
  session?: ServerSession;
  constructor(readonly broker: FakeBroker, readonly client: LinkHandlers) {}
  /** Server → client. */
  deliver(data: string | Buffer) {
    if (!this.open || this.broker.blackhole) return;
    const copy = typeof data === 'string' ? data : Buffer.from(data);
    later(() => { if (this.open) this.client.message(copy); });
  }
  /** Close after what was already delivered, as a TCP close follows the bytes before it. */
  drop(reason = 'reset by the fake broker') {
    if (!this.open || this.closing) return;
    this.closing = true;
    if (this.session?.conn === this) this.session.conn = undefined;
    later(() => { this.open = false; this.client.closed(reason); });
  }
  closing = false;
}

export class FakeBroker {
  readonly sessions = new Map<string, ServerSession>();
  readonly conns: Conn[] = [];
  /** Text and binary messages the broker received, for assertions. */
  readonly received: Array<{ kind: 'hello' | 'ack' | 'envelope' | 'bye'; value: any }> = [];
  credential = 'good-credential';
  heartbeatMs = 5000;
  graceMs = 600_000;
  /** Refuse this many connection attempts. */
  refuse = 0;
  /** Swallow traffic both ways without closing, as a blackhole does. */
  blackhole = false;
  /** Receive envelopes without acknowledging them, as a proxy that holds the acknowledgements does. */
  holdAcks = false;
  /** Send the next envelope twice. */
  duplicateNext = false;
  /** Hold the next envelope and send it after the one after it. */
  reorderNext = false;
  private held?: { conn: Conn; data: Buffer };
  /** What the server-side application does with each body. */
  app: (session: ServerSession, body: Buffer) => void = (session, body) => this.send(session, Buffer.concat([Buffer.from('echo:'), body]));

  readonly dial: Dial = handlers => new Promise<Link>((resolve, reject) => {
    if (this.refuse > 0) { this.refuse--; later(() => reject(new Error('connection refused'))); return; }
    const conn = new Conn(this, handlers);
    this.conns.push(conn);
    later(() => resolve({
      send: data => { const copy = typeof data === 'string' ? data : Buffer.from(data); later(() => { if (conn.open && !this.blackhole) this.receive(conn, copy); }); },
      close: () => later(() => { conn.open = false; if (conn.session?.conn === conn) conn.session.conn = undefined; }),
    }));
  });

  /** Server → client body, as an envelope in the session. */
  send(session: ServerSession, body: Buffer) {
    session.seq.push(body);
    this.pump(session);
  }
  pump(session: ServerSession) {
    const conn = session.conn;
    if (!conn?.open) return;
    for (let envelope = session.seq.next(); envelope; envelope = session.seq.next()) {
      const data = encodeEnvelope(envelope);
      if (this.reorderNext && !this.held) { this.held = { conn, data }; this.reorderNext = false; continue; }
      conn.deliver(data);
      if (this.held?.conn === conn) { conn.deliver(this.held.data); this.held = undefined; }
      if (this.duplicateNext) { conn.deliver(data); this.duplicateNext = false; }
    }
  }
  dropAll(reason?: string) { for (const conn of this.conns) conn.drop(reason); }
  /** Forget every session, as a broker restart does. */
  forget() { this.sessions.clear(); this.dropAll('broker restarted'); }
  /** Acknowledge everything received on each open connection now. */
  ackNow() { for (const conn of this.conns) if (conn.open && conn.session) conn.deliver(JSON.stringify({ type: 'ack', ack: conn.session.seq.markAckSent() })); }
  ackCount() { return this.received.filter(r => r.kind === 'ack').length; }

  private receive(conn: Conn, data: string | Buffer) {
    if (!conn.session) {
      const hello = JSON.parse(String(data));
      this.received.push({ kind: 'hello', value: hello });
      if (hello.type !== 'hello' || hello.credential !== this.credential) { conn.deliver(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'bad credential' })); conn.drop(); return; }
      if (hello.session === null) {
        const session: ServerSession = { id: randomUUID(), seq: new SeqState(), principal: hello.credential, app: () => {} };
        session.app = body => this.app(session, body);
        this.sessions.set(session.id, session);
        session.seq.resume(0);
        conn.session = session; session.conn = conn;
        conn.deliver(JSON.stringify({ type: 'welcome', session: session.id, resumed: false, received: 0, heartbeat_ms: this.heartbeatMs, grace_ms: this.graceMs }));
        this.onOpen?.(session);
        this.pump(session);
        return;
      }
      const session = this.sessions.get(hello.session);
      if (!session) { conn.deliver(JSON.stringify({ type: 'expired', session: hello.session, reason: 'unknown' })); conn.drop(); return; }
      session.conn?.drop('superseded');
      session.seq.resume(hello.received);
      conn.session = session; session.conn = conn;
      conn.deliver(JSON.stringify({ type: 'welcome', session: session.id, resumed: true, received: session.seq.received, heartbeat_ms: this.heartbeatMs, grace_ms: this.graceMs }));
      this.pump(session);
      return;
    }
    const session = conn.session;
    if (typeof data === 'string') {
      const control = JSON.parse(data);
      if (control.type === 'ack') { this.received.push({ kind: 'ack', value: control.ack }); session.seq.ack(control.ack); return; }
      if (control.type === 'bye') { this.received.push({ kind: 'bye', value: null }); this.sessions.delete(session.id); conn.drop(); return; }
      return;
    }
    if (data.length > (1 << 20)) { conn.drop('message too big'); return; }
    const envelope = decodeEnvelope(data);
    this.received.push({ kind: 'envelope', value: envelope.seq });
    let body: Buffer | undefined;
    try { body = session.seq.accept(envelope); } catch { conn.drop('protocol error'); return; }
    if (session.seq.needsAck && !this.holdAcks) conn.deliver(JSON.stringify({ type: 'ack', ack: session.seq.markAckSent() }));
    if (body) session.app(Buffer.from(body));
  }
  onOpen?: (session: ServerSession) => void;
}

interface Execution { op: Op; output: Buffer; outcome?: Outcome; runs: number }
/** An upload the fake relay agent holds between its call and its end, by execution ID (RP-15). */
interface Held { op: Op; chunks: Buffer[]; size: number; owner?: string; reported: number }
const PROGRESS_STEP = 4 * 1024 * 1024;
/**
 * The relay layer over FakeBroker: `ready` first, then calls with execution
 * records. `exec` runs a tiny command language: `echo <text>` prints the
 * text, `hold` waits until the test calls `finish`. Protocol 2 (RP-15): an
 * upload is held by execution ID, its progress reported, and a call with
 * `resume` continues it; a read starts at `offset`.
 */
export class FakeRelay {
  readonly executions = new Map<string, Execution>();
  readonly calls: Array<{ execution: string; op: Op; size: number; resume?: boolean; offset?: number }> = [];
  readonly queries: string[] = [];
  readonly chunkSizes: number[] = [];
  readonly held = new Map<string, Held>();
  private readonly holds = new Map<string, Array<() => void>>();
  /** Answer `unknown` to every query. */
  forgetRecords = false;
  /** The relay protocol in `ready`. */
  protocol = 2;
  /** End an upload with `upload_incomplete` once the agent holds this many bytes of it, once, as a lost agent session does. */
  cutUploadAt?: number;
  /** Withhold progress reports, so the client's window fills. */
  stallProgress = false;
  /** The most bytes of an upload that arrived beyond the last progress reported. */
  maxAhead = 0;
  /** A read's bytes, by path; `contents of <path>` otherwise. */
  readonly files = new Map<string, Buffer>();
  /** Send only this many bytes of the next read, then forget every session, as a broker restart does. */
  cutReadAt?: number;
  private report?: () => void;
  constructor(readonly broker: FakeBroker) {
    broker.onOpen = session => broker.send(session, encodeControl('ready', { protocol: this.protocol, lease: 'fake-lease', agent: { os: 'macos', arch: 'aarch64', build: 'f'.repeat(64), protocol: this.protocol } }));
    broker.app = (session, body) => {
      const reply = (name: string, value: unknown) => broker.send(session, encodeControl(name, value));
      const message = decodeMessage(body);
      const key = (call: number) => `${session.id}:${call}`;
      if ('chunk' in message) {
        this.chunkSizes.push(message.chunk.data.length);
        const entry = [...this.held.entries()].find(([, held]) => held.owner === key(message.chunk.call));
        if (!entry) return; // a call that ended before its stream did
        const [execution, held] = entry;
        held.chunks.push(Buffer.from(message.chunk.data)); held.size += message.chunk.data.length;
        this.maxAhead = Math.max(this.maxAhead, held.size - held.reported);
        if (this.cutUploadAt !== undefined && held.size >= this.cutUploadAt) {
          this.cutUploadAt = undefined; held.owner = undefined;
          return reply('result', { call: message.chunk.call, execution, replayed: false, outcome: { failed: { code: 'upload_incomplete', message: 'the relay agent\'s session ended', committed: false } } });
        }
        const progress = () => { held.reported = held.size; reply('progress', { call: message.chunk.call, execution, committed: held.size }); };
        if (this.protocol >= 2 && held.size >= held.reported + PROGRESS_STEP) {
          if (this.stallProgress) this.report = progress; else progress();
        }
        return;
      }
      const { name, value } = message;
      if (name === 'query') {
        this.queries.push(value.execution);
        const record = this.forgetRecords ? undefined : this.executions.get(value.execution);
        const state = !record ? 'unknown' : record.outcome ? { completed: { op: Object.keys(record.op)[0], outcome: record.outcome } } : { running: { op: Object.keys(record.op)[0] } };
        return reply('query_result', { call: value.call, execution: value.execution, state });
      }
      if (name === 'call') {
        const kind = typeof value.op === 'string' ? value.op : Object.keys(value.op)[0];
        if (['exec', 'script', 'write', 'write_tree'].includes(kind)) {
          const known = this.executions.get(value.execution);
          if (known) return this.start(session, value.call, value.execution, value.op, Buffer.alloc(0), reply, 0);
          let held = this.held.get(value.execution);
          if (!held || !value.resume || JSON.stringify(held.op) !== JSON.stringify(value.op)) { held = { op: value.op, chunks: [], size: 0, reported: 0 }; this.held.set(value.execution, held); }
          held.owner = key(value.call); held.reported = held.size;
          this.calls.push({ execution: value.execution, op: value.op, size: -1, resume: !!value.resume });
          if (this.protocol >= 2) reply('progress', { call: value.call, execution: value.execution, committed: held.size });
          return;
        }
        return this.start(session, value.call, value.execution, value.op, Buffer.alloc(0), reply, value.offset ?? 0);
      }
      if (name === 'end') {
        const entry = [...this.held.entries()].find(([, held]) => held.owner === key(value.call));
        if (!entry) return;
        const [execution, held] = entry;
        held.owner = undefined;
        const fail = (code: string) => reply('result', { call: value.call, execution: value.execution, replayed: false, outcome: { failed: { code, message: code, committed: false } } });
        if (held.size < value.size) return fail('upload_incomplete');
        const bytes = Buffer.concat(held.chunks);
        this.held.delete(execution);
        if (bytes.length !== value.size || createHash('sha256').update(bytes).digest('hex') !== value.sha256) return fail('checksum_mismatch');
        const placeholder = this.calls.findIndex(c => c.execution === value.execution && c.size === -1);
        if (placeholder >= 0) this.calls.splice(placeholder, 1);
        return this.start(session, value.call, value.execution, held.op, bytes, reply, 0);
      }
    };
  }
  /** Report the progress that `stallProgress` withheld, and report as bytes come from now on. */
  release() { this.stallProgress = false; const report = this.report; this.report = undefined; report?.(); }
  /** Let every `hold` command of this execution finish. */
  finish(execution: string) { for (const go of this.holds.get(execution) ?? []) go(); this.holds.delete(execution); }
  runs(execution: string) { return this.executions.get(execution)?.runs ?? 0; }

  private start(session: any, call: number, execution: string, op: Op, upload: Buffer, reply: (name: string, value: unknown) => void, offset: number) {
    this.calls.push({ execution, op, size: upload.length, offset });
    const stream = (data: Buffer) => { for (let at = 0; at < data.length; at += MAX_CHUNK) this.broker.send(session, encodeChunk(call, data.subarray(at, at + MAX_CHUNK))); };
    const digest = (data: Buffer) => ({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    const answer = (record: Execution, replayed: boolean) => {
      if (typeof record.op === 'object' && ('exec' in record.op || 'script' in record.op)) { stream(record.output); reply('end', { call, execution, ...digest(record.output) }); }
      reply('result', { call, execution, replayed, outcome: record.outcome });
    };
    const known = this.executions.get(execution);
    if (known) {
      if (known.outcome) return answer(known, true);
      const waiting = this.holds.get(execution) ?? []; waiting.push(() => answer(known, true)); this.holds.set(execution, waiting);
      return;
    }
    const record: Execution = { op, output: Buffer.alloc(0), runs: 1 };
    this.executions.set(execution, record);
    if (typeof op === 'object' && 'exec' in op) {
      const command = op.exec.command;
      const done = () => { record.outcome = { exit: { rc: 0, signal: null, timed_out: false, cancelled: false, output: digest(record.output) } }; };
      if (command === 'hold') {
        const waiting = this.holds.get(execution) ?? [];
        waiting.unshift(() => { record.output = Buffer.from('held\n'); done(); answer(record, false); });
        this.holds.set(execution, waiting);
        return;
      }
      record.output = Buffer.from(command.startsWith('echo ') ? `${command.slice(5)}\n` : command === 'big' ? 'x'.repeat(3 * 1024 * 1024) : `ran: ${command}\n`);
      done(); return answer(record, false);
    }
    if (typeof op === 'object' && 'script' in op) {
      record.output = Buffer.concat([Buffer.from('script: '), upload]);
      record.outcome = { exit: { rc: 0, signal: null, timed_out: false, cancelled: false, output: digest(record.output) } };
      return answer(record, false);
    }
    if (typeof op === 'object' && ('write' in op || 'write_tree' in op)) { record.output = upload; record.outcome = { written: digest(upload) }; return answer(record, false); }
    if (typeof op === 'object' && ('read' in op || 'read_tree' in op)) {
      const path = 'read' in op ? op.read.path : op.read_tree.path;
      const data = this.files.get(path) ?? Buffer.from(`contents of ${path}`);
      record.outcome = { read: digest(data) };
      if (this.cutReadAt !== undefined) {
        const cut = this.cutReadAt; this.cutReadAt = undefined;
        stream(data.subarray(offset, offset + cut));
        setTimeout(() => this.broker.forget(), 20);
        return;
      }
      stream(data.subarray(offset)); reply('end', { call, execution, ...digest(data) });
      return reply('result', { call, execution, replayed: false, outcome: record.outcome });
    }
    if (typeof op === 'object' && 'cancel' in op) { record.outcome = { cancel: { target: op.cancel.target, found: 'unknown' } }; return answer(record, false); }
    record.outcome = { status: { protocol: 1, build: 'f'.repeat(64), os: 'macos', running: [] } };
    return answer(record, false);
  }
}
