import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { selectedEnvironment, type SelectedEnvironment, type EnvironmentIdentity } from './environment.js';
import { serviceUrl } from './config.js';
import { checkGrant, fileSource, RelayClient, RelayFailedError, RelayUncertainError, type CallAnswer, type Op, type RelayClientOptions, type RelayGrant, type UploadSource } from './relay-client.js';

/**
 * The daemon's actual record; acquire returns this directly, not a lease wrapper.
 * A durable machine's record names it `name`, has no image, and carries the
 * lease's `workspace` and the machine's `capabilities`; the relay reads it as
 * a lease whose `vm` is that name (docs/durable-machines.md §3).
 */
export interface VmLease {
  vm: string;
  kind?: "virtual" | "durable";
  instance?: string;
  machine_id?: string;
  lease_id?: string;
  console?: import('./console.js').ConsoleStatus;
  purpose: string;
  image: string | null;
  image_kind: "macos" | "linux" | null;
  env: string | null;
  state: "pending" | "provisioning" | "running" | "releasing" | "leased";
  workspace?: string;
  capabilities?: { software?: Record<string, unknown> | null } & Record<string, unknown>;
  created_at: number;
  ttl_expires_at: number;
  grace_until: number | null;
  warned: boolean;
  /** How the lease's guest operations travel: through the broker to the relay agent, or over SSH because the agent did not register (RP-11, RA-8). */
  link?: "relay" | "ssh-fallback";
  link_reason?: string;
  /** The acquisition answer's broker grant; only the answer carries it (RP-11). */
  relay?: RelayGrant;
  ip: string | null;
  cpu: number | null;
  memory_mb: number | null;
  disk_gb: number | null;
}
export interface VmSnapshot extends VmLease {
  ttl_hours_remaining: number;
  grace_hours_remaining?: number;
  actually_running: boolean;
}
export interface MachineList {
  machines: Record<string, VmSnapshot>;
  limits: { max_macos_running: number; grace_hours: number };
  pilot_repo: string;
  port: number;
}
export interface VmImages {
  images: Record<string, {
    kind: "macos" | "linux";
    base_vm: string;
    base_available: boolean;
    clone_prefix: string;
    defaults: { cpu: number; memory_mb: number; disk_gb: number | null };
    source: string;
    concurrency: { running: number; limit: number | null; acquirable: boolean };
    active_purposes: string[];
  }>;
  capacity: { macos_running: number; macos_limit: number; host_macos_guests?: number; foreign_macos_guests?: number };
  /** The instance's image catalog status (machine-service IC-5): its generation, and `current`, `stale` or `unavailable`. */
  catalog?: { generation?: number; status?: string; built_at?: number; error?: string; failed_at?: number; file?: string };
}
export interface AcquireRequest {
  purpose: string;
  image?: string;
  /** A durable machine's name, in place of `image` (DC-29). */
  machine?: string;
  env?: string;
  ttl_hours?: number;
  cpu?: number;
  memory_mb?: number;
  disk_gb?: number;
  wait?: boolean;
  vnc?: boolean;
  /** The guest's network (machine-service DC-13): `nat`, or `internet` for a guest that reaches neither the host nor a private network. */
  network?: 'nat' | 'internet';
}
/** `lease_id` is required on a durable machine and accepted on a VM (DC-30). */
export interface LeaseIdentity { lease_id?: string }
/** `execution_id` names the operation for machine-service's and the relay agent's records: a repeat never runs again (BK-3, RP-7). */
export type ExecRequest = ({ argv: string[]; script?: never } | { script: string; argv?: never }) & { timeout?: number; execution_id?: string } & LeaseIdentity;
export interface TransferRequest extends LeaseIdentity { local_path: string; remote_path: string }
export interface ExecResponse { vm: string; rc: number; output: string; link?: "relay"; execution_id?: string }
export interface PushResponse { vm: string; pushed: string; to: string }
export interface PullResponse { vm: string; pulled: string; to: string }
export interface ReleaseResponse { vm?: string; name?: string; released: boolean; reason: string; hygiene?: unknown }
export interface BytesResponse { sha256: string; bytes: number }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
/** How the client sends a request: the platform's fetch in production, a stand-in in tests (DC-62). */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
/**
 * A client names its instance: the origin, or a selected environment that
 * binds one. There is no default origin here; `machineServiceFromProcess`
 * supplies the installed one to production (DC-62).
 */
export type MachineServiceOptions = MachineServiceSettings & ({ baseUrl: string; environment?: SelectedEnvironment } | { baseUrl?: string; environment: SelectedEnvironment });
export interface MachineServiceSettings {
  /** How requests are sent; default the platform's fetch. */
  transport?: Transport;
  timeoutMs?: number;
  acquireTimeoutMs?: number;
  maxResponseBytes?: number;
  /** The origin is an instance that discovery found, by its Bonjour advertisement or its Consul registration, which may be on another Mac (DC-29, DC-35). */
  listed?: boolean;
  /** Options of the broker sessions, for tests. */
  relay?: RelayClientOptions;
}

/**
 * The client a relay process uses: the selected environment's instance, else
 * MCP_RELAY_URL, else the installed one; under the test harness there is no
 * default and the installed instance is refused (config.serviceUrl, DC-61).
 */
export function machineServiceFromProcess(env: NodeJS.ProcessEnv = process.env, environment = selectedEnvironment(env), settings: MachineServiceSettings = {}): MachineService {
  const baseUrl = serviceUrl(env, environment);
  return new MachineService(environment ? { ...settings, baseUrl, environment } : { ...settings, baseUrl });
}

/** The manager depends on this protocol, not on a concrete transport or hypervisor. */
export type VmBackend = Pick<MachineService, 'baseUrl' | 'health' | 'list' | 'images' | 'applications' | 'get' | 'acquire' | 'exec' | 'push' | 'pull' | 'heartbeat' | 'release'> & Partial<Pick<MachineService, 'acquisitionCapabilities' | 'consoleResolve' | 'consoleOpen' | 'consoleCancel' | 'pushBytes' | 'pullBytes' | 'useRelay'>>;

export class MachineServiceError extends Error {
  /** The host is at capacity, such as its limit on running macOS VMs: nothing was reserved, and the same acquisition may be asked again (DC-22). */
  capacity = false;
  constructor(message: string, readonly status?: number, readonly responseBody?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MachineServiceError";
  }
}
/**
 * machine-service's refusal of an acquisition because the host is at capacity:
 * HTTP 409 whose error is its macOS VM limit, refused before any lease was
 * reserved. Any other 409, or one whose outcome is uncertain, is not (DC-22).
 */
export function capacityRefusal(error: unknown): boolean {
  if (!(error instanceof MachineServiceError) || error.status !== 409 || !error.responseBody) return false;
  let body: unknown;
  try { body = JSON.parse(error.responseBody); } catch { return false; }
  if (!body || typeof body !== "object") return false;
  const { error: reason, outcome } = body as { error?: unknown; outcome?: unknown };
  // A durable machine leased by someone else, or without a GUI session, may free up the same way (DC-34).
  return typeof reason === "string" && /^(macOS VM limit reached|durable machine leased|durable machine unavailable)/.test(reason) && outcome !== "uncertain";
}
/**
 * The name machine-service answers in `/health`. vm-service, its name before
 * the rename, answers `vm-service` and serves none of the `/machines` paths,
 * so the relay refuses it rather than failing later on a path (DC-27).
 */
export const SERVICE_NAME = "machine-service";
export function expectMachineService(health: { service?: unknown }, origin: string): void {
  if (health.service === SERVICE_NAME) return;
  throw new Error(`The service at ${origin} answers as ${JSON.stringify(health.service ?? null)}, not ${SERVICE_NAME}. This relay speaks only machine-service's /machines API: install machine-service, which replaced vm-service.`);
}
/** A pull over the byte-carrying endpoint is abandoned when no byte arrives for this long, however large the file. */
const PULL_IDLE_MS = 120_000;
/** No acquire retry is safe: the daemon has no idempotency key/cancel endpoint. */
export class AcquireIndeterminateError extends MachineServiceError {
  constructor(readonly purpose: string, cause: unknown) {
    super(`Acquisition outcome unknown for purpose '${purpose}'; reconcile GET /machines before retrying or ending the enclosure`, undefined, undefined, { cause });
    this.name = "AcquireIndeterminateError";
  }
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** A durable machine's record names it `name`; the relay reads that as the lease's `vm` (docs/durable-machines.md §3). */
function named<T>(value: T): T {
  const fields = value as Record<string, unknown>;
  if (record(value) && fields.kind === "durable" && typeof fields.vm !== "string" && typeof fields.name === "string") fields.vm = fields.name;
  return value;
}
function isLease(value: unknown): value is VmLease {
  if (!record(value)) return false;
  if (named(value).kind === "durable") {
    return ["vm", "purpose", "lease_id", "workspace"].every(k => typeof value[k] === "string" && value[k] !== "")
      && value.image === null && value.image_kind === null && value.state === "leased"
      && ["created_at", "ttl_expires_at"].every(k => typeof value[k] === "number" && Number.isFinite(value[k]));
  }
  return ["vm", "purpose", "image"].every(k => typeof value[k] === "string" && value[k] !== "")
    && ["macos", "linux"].includes(String(value.image_kind))
    && ["pending", "provisioning", "running", "releasing"].includes(String(value.state))
    && ["created_at", "ttl_expires_at"].every(k => typeof value[k] === "number" && Number.isFinite(value[k]))
    && ["cpu", "memory_mb", "disk_gb", "grace_until"].every(k => value[k] === null || typeof value[k] === "number")
    && ["env", "ip"].every(k => value[k] === null || typeof value[k] === "string")
    && typeof value.warned === "boolean";
}

/** machine-service's shell quoting of an argv for a command line (its `ssh::shell_quote`), so a command means the same over either link. */
export function shellQuote(value: string): string {
  if (value && /^[A-Za-z0-9@%_\-+=:,./]+$/.test(value)) return value;
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
/** The last `max` characters, as machine-service bounds an exec's output. */
function tailChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(chars.length - max).join("");
}
/** One lease's broker link: its grant, and once the instance's advertisement matched it, its session. */
interface RelayRoute { grant: RelayGrant; checked?: Promise<RelayClient | undefined> }

export class MachineService {
  readonly baseUrl: string;
  /** Leases whose operations go through the broker, by machine name (docs/relay-agent-link.md §3). */
  private readonly relays = new Map<string, RelayRoute>();
  private readonly relayOptions?: RelayClientOptions;
  private readonly environment?: SelectedEnvironment;
  private readonly timeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: Transport;

  constructor(options: MachineServiceOptions | string) {
    if (typeof options === "string") options = { baseUrl: options };
    this.environment = options.environment;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    const named = options.baseUrl ?? options.environment?.profile.vmServiceUrl;
    if (named === undefined) throw new TypeError("machine-service client needs its origin: a baseUrl or a selected environment");
    const url = new URL(named);
    if (options.environment && url.origin !== new URL(options.environment.profile.vmServiceUrl).origin) throw new TypeError('Backend endpoint does not match the selected environment');
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if ((!loopback && !options.listed) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("machine-service baseUrl must be a loopback HTTP(S) origin, or one discovery found, without credentials, path, query or fragment");
    }
    this.baseUrl = url.origin;
    this.timeoutMs = positive(options.timeoutMs ?? 660_000, "timeoutMs");
    this.acquireTimeoutMs = positive(options.acquireTimeoutMs ?? 3_600_000, "acquireTimeoutMs");
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
    this.relayOptions = options.relay;
  }

  /**
   * Route a lease's guest operations through the broker when its record says
   * `link: relay` and it carries the acquisition's grant; any other lease,
   * `ssh-fallback` included, keeps the HTTP operations (§6).
   */
  useRelay(vm: string, lease: { link?: string; relay?: RelayGrant }): void {
    const known = this.relays.get(vm);
    if (lease.link === "relay" && lease.relay) {
      if (known && known.grant.credential === lease.relay.credential) return;
      this.dropRelay(vm);
      this.relays.set(vm, { grant: lease.relay });
      return;
    }
    this.dropRelay(vm);
  }
  /** Whether a lease's operations go through the broker: the grant matches what the instance advertises. */
  async relayLink(vm: string): Promise<boolean> { return !!(await this.relayFor(vm)); }
  private dropRelay(vm: string) {
    const route = this.relays.get(vm);
    this.relays.delete(vm);
    void route?.checked?.then(client => client?.close(), () => {});
  }
  private relayFor(vm: string): Promise<RelayClient | undefined> {
    const route = this.relays.get(vm);
    if (!route) return Promise.resolve(undefined);
    route.checked ??= (async () => {
      // The instance must still advertise the broker and the same authority (RP-1, RP-11).
      const health = await this.request<{ relay_url?: unknown; relay_ca_sha256?: unknown }>("/health", undefined, { timeoutMs: 10000 });
      const refused = checkGrant(route.grant, health);
      if (refused) return undefined;
      return new RelayClient(route.grant, this.relayOptions);
    })();
    route.checked.catch(() => { if (this.relays.get(vm) === route) route.checked = undefined; });
    return route.checked;
  }
  /** One operation through the broker, its `failed` and `interrupted` outcomes as errors. */
  private async relayRun(client: RelayClient, op: Op, upload: Buffer | UploadSource, executionId: string, options: RequestOptions & { sink?: import('./relay-client.js').Sink }): Promise<CallAnswer> {
    let answer: CallAnswer;
    try { answer = await client.run(op, upload, { executionId, ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.sink ? { sink: options.sink } : {}) }); }
    catch (cause) {
      if (options.signal?.aborted && cause === options.signal.reason) throw cause;
      throw new MachineServiceError(`machine-service relay link: ${(cause as Error).message}`, undefined, undefined, { cause });
    }
    const outcome = answer.outcome as Record<string, any>;
    if (outcome.failed) {
      const failure = new RelayFailedError(answer.executionId, outcome.failed.code, outcome.failed.message, outcome.failed.committed);
      throw new MachineServiceError(failure.message, undefined, undefined, { cause: failure });
    }
    if (outcome.interrupted) {
      const failure = new RelayUncertainError(answer.executionId, `relay: the relay agent stopped while the operation ran: ${outcome.interrupted.message}`);
      throw new MachineServiceError(failure.message, undefined, undefined, { cause: failure });
    }
    return answer;
  }

  health(options: RequestOptions = {}): Promise<{ ok: boolean; service: string; instance?: string; machine_id?: string; environment?: EnvironmentIdentity }> {
    return this.request("/health", undefined, options);
  }
  async list(options: RequestOptions = {}): Promise<MachineList> {
    const list = await this.request<MachineList>("/machines", undefined, options);
    if (record(list.machines)) Object.values(list.machines).forEach(named);
    return list;
  }
  images(options: RequestOptions = {}): Promise<VmImages> { return this.request("/images", undefined, options); }
  applications(options: RequestOptions = {}): Promise<unknown> { return this.request("/applications", undefined, options); }
  acquisitionCapabilities(options: RequestOptions = {}): Promise<unknown> { return this.consoleRequest('/acquisition-capabilities', undefined, options); }
  consoleResolve(vm: string, body: { lease_id: string }, options: RequestOptions = {}): Promise<unknown> { return this.consoleRequest(this.path(vm, 'console/resolve'), body, options); }
  consoleOpen(vm: string, body: { lease_id: string; console_id: string; attempt_id: string }, options: RequestOptions = {}): Promise<unknown> { return this.consoleRequest(this.path(vm, 'console/open'), body, options); }
  consoleCancel(vm: string, body: { lease_id: string; console_id: string; attempt_id: string }, options: RequestOptions = {}): Promise<unknown> { return this.consoleRequest(this.path(vm, 'console/cancel'), body, options); }
  private async consoleRequest(path: string, body: unknown, options: RequestOptions): Promise<unknown> {
    try { return await this.request(path, body, options); }
    catch (error) {
      // Backend diagnostics may contain connection material. Never reflect them.
      throw new MachineServiceError(`Console API unavailable or request outcome unknown${error instanceof MachineServiceError && error.status ? ` (HTTP ${error.status})` : ''}; resolve before another open`, error instanceof MachineServiceError ? error.status : undefined);
    }
  }
  async get(vm: string, options: RequestOptions & LeaseIdentity = {}): Promise<VmSnapshot> {
    const path = this.path(vm) + (options.lease_id ? `?${new URLSearchParams({ lease_id: options.lease_id })}` : "");
    return named(await this.request<VmSnapshot>(path, undefined, options));
  }

  /**
   * Cancellation before dispatch prevents allocation. Once dispatched we deliberately
   * do NOT abort the request: return the lease even if the caller cancels, so its
   * finally/cleanup path can register and release it. Caller must track the returned
   * lease before checking its signal. Network loss/deadline remains indeterminate
   * (a daemon protocol limitation); never blindly retry acquisition.
   */
  async acquire(body: AcquireRequest, options: RequestOptions = {}): Promise<VmLease> {
    options.signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.purpose)) throw new TypeError("Invalid VM purpose");
    const timeoutMs = positive(options.timeoutMs ?? this.acquireTimeoutMs, "timeoutMs");
    try {
      const lease = await this.request<unknown>("/acquire", body, { timeoutMs });
      if (!isLease(lease)) throw new MachineServiceError("Invalid machine-service acquire response");
      this.useRelay(lease.vm, lease);
      return lease;
    } catch (error) {
      // VNC provisioning errors must not reflect adapter diagnostics or secrets.
      const safeError = body.vnc ? new MachineServiceError(`VNC acquisition refused or outcome unknown${error instanceof MachineServiceError && error.status ? ` (HTTP ${error.status})` : ''}; inspect capabilities and reconcile ownership`, error instanceof MachineServiceError ? error.status : undefined) : error;
      // A capacity refusal stays recognisable even when the VNC message hides the daemon's text (DC-22).
      if (safeError instanceof MachineServiceError) safeError.capacity = capacityRefusal(error);
      // A 4xx is an explicit daemon refusal; all other outcomes require reconciliation.
      if (error instanceof MachineServiceError && error.status !== undefined && error.status >= 400 && error.status < 500) throw safeError;
      throw new AcquireIndeterminateError(body.purpose, safeError);
    }
  }
  /**
   * On a `relay` lease the command runs through the broker in the desktop
   * session, under the request's execution ID, and answers as machine-service's
   * own relay route does; otherwise one HTTP request.
   */
  exec(vm: string, body: ExecRequest, options: RequestOptions = {}): Promise<ExecResponse> {
    this.path(vm); // an invalid name throws before anything is sent
    return this.execRouted(vm, body, options);
  }
  private async execRouted(vm: string, body: ExecRequest, options: RequestOptions): Promise<ExecResponse> {
    const client = await this.relayFor(vm);
    if (!client) return this.request(this.path(vm, "exec"), body, options);
    const timeout = body.timeout ?? 600;
    if (!(timeout > 0)) throw new MachineServiceError("timeout must be positive");
    const executionId = body.execution_id ?? randomUUID();
    const [op, upload]: [Op, Buffer] = body.script !== undefined
      ? [{ script: { timeout_s: timeout } }, Buffer.from(body.script)]
      : [{ exec: { command: body.argv!.map(shellQuote).join(" "), stdin: false, timeout_s: timeout } }, Buffer.alloc(0)];
    const answer = await this.relayRun(client, op, upload, executionId, { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
    const exit = (answer.outcome as { exit?: { rc: number | null; timed_out: boolean } }).exit;
    if (!exit) throw new MachineServiceError(`machine-service relay link: unexpected outcome ${JSON.stringify(answer.outcome)}`);
    if (exit.timed_out) throw new MachineServiceError(`machine-service relay link: the command timed out after ${timeout}s and was killed`);
    return { vm, rc: exit.rc ?? 255, output: tailChars(answer.output.toString("utf8"), 64000), link: "relay", execution_id: answer.executionId };
  }
  /** On a `relay` lease a file goes as a `write` through the broker; a folder still goes over HTTP, as machine-service sends folders by `scp` (DC-151). */
  push(vm: string, body: TransferRequest, options: RequestOptions = {}): Promise<PushResponse> {
    this.path(vm); // an invalid name throws before anything is sent
    return this.pushRouted(vm, body, options);
  }
  private async pushRouted(vm: string, body: TransferRequest, options: RequestOptions): Promise<PushResponse> {
    const client = await this.relayFor(vm);
    const facts = client ? await stat(body.local_path) : undefined;
    if (!client || !facts?.isFile()) return this.request(this.path(vm, "push"), body, options);
    // The file streams from the disk and continues after a loss (RP-15), so its size needs no memory.
    const source = await fileSource(body.local_path);
    const answer = await this.relayRun(client, { write: { path: body.remote_path, name: basename(body.local_path), mode: facts.mode & 0o777 } }, source, randomUUID(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
    const written = (answer.outcome as { written?: { size: number; sha256: string } }).written;
    if (!written || written.size !== source.size || written.sha256 !== source.sha256) throw new MachineServiceError(`machine-service relay link: the relay agent wrote ${JSON.stringify(answer.outcome)}, not what was sent`);
    return { vm, pushed: body.local_path, to: body.remote_path };
  }
  /** On a `relay` lease a file comes as a `read` through the broker, checked and renamed into place; a guest folder still goes over HTTP. */
  pull(vm: string, body: TransferRequest, options: RequestOptions = {}): Promise<PullResponse> {
    this.path(vm); // an invalid name throws before anything is sent
    return this.pullRouted(vm, body, options);
  }
  private async pullRouted(vm: string, body: TransferRequest, options: RequestOptions): Promise<PullResponse> {
    const client = await this.relayFor(vm);
    if (!client) return this.request(this.path(vm, "pull"), body, options);
    const part = `${body.local_path}.relay-${randomUUID()}.part`;
    try {
      await this.relayRead(client, body.remote_path, part, options);
    } catch (error) {
      await rm(part, { force: true });
      if (((error as Error).cause as RelayFailedError | undefined)?.code === "is_directory") return this.request(this.path(vm, "pull"), body, options);
      throw error;
    }
    await rename(part, body.local_path);
    return { vm, pulled: body.remote_path, to: body.local_path };
  }
  /** Read a guest file into `to`, which must not exist, streaming and hashing it; the bytes must match the read's outcome. */
  private async relayRead(client: RelayClient, remote: string, to: string, options: RequestOptions): Promise<BytesResponse> {
    const file = await open(to, "wx", 0o600);
    let position = 0, writing: Promise<unknown> = Promise.resolve();
    const sink = {
      write: (data: Buffer) => { const at = position; position += data.length; writing = writing.then(() => file.write(data, 0, data.length, at)); },
      reset: () => { position = 0; writing = writing.then(() => file.truncate(0)); },
    };
    try {
      const answer = await this.relayRun(client, { read: { path: remote } }, Buffer.alloc(0), randomUUID(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs, sink });
      await writing;
      const read = (answer.outcome as { read?: { size: number; sha256: string } }).read;
      if (!read || !answer.stream || answer.stream.size !== read.size || answer.stream.sha256 !== read.sha256 || position !== read.size) throw new MachineServiceError(`machine-service relay link: the bytes of ${remote} do not match their SHA-256; pull again`);
      await file.sync();
      return { sha256: read.sha256, bytes: read.size };
    } finally { await writing.catch(() => {}); await file.close(); }
  }
  async heartbeat(vm: string, body: { ttl_hours?: number } & LeaseIdentity = {}, options: RequestOptions = {}): Promise<VmLease & { ttl_hours_remaining: number }> {
    return named(await this.request<VmLease & { ttl_hours_remaining: number }>(this.path(vm, "heartbeat"), body, options));
  }
  release(vm: string, body: { reason?: string } & LeaseIdentity = {}, options: RequestOptions = {}): Promise<ReleaseResponse> {
    // Release revokes the lease's credential; the session ends with it (RP-10).
    this.dropRelay(vm);
    return this.request(this.path(vm, "release"), body, options);
  }
  /**
   * Push one file as bytes, `PUT /machines/<name>/files` (FD-4): the instance
   * checks the digest before it writes, so a client on another Mac needs no
   * host path the instance could read (DC-31).
   */
  async pushBytes(vm: string, body: { remote_path: string; bytes: Buffer } & LeaseIdentity, options: RequestOptions = {}): Promise<BytesResponse> {
    const sha256 = createHash("sha256").update(body.bytes).digest("hex");
    const client = await this.relayFor(vm);
    if (client) {
      const answer = await this.relayRun(client, { write: { path: body.remote_path, name: "", mode: null } }, body.bytes, randomUUID(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
      const written = (answer.outcome as { written?: BytesResponse & { size: number } }).written;
      if (!written || written.sha256 !== sha256 || written.size !== body.bytes.length) throw new MachineServiceError(`machine-service relay link: the relay agent wrote ${JSON.stringify(answer.outcome)}, not what was sent`);
      return { sha256, bytes: body.bytes.length };
    }
    const response = await this.fetchBounded(this.filesPath(vm, body.remote_path, body.lease_id), { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Content-SHA256": sha256 }, body: new Uint8Array(body.bytes.buffer as ArrayBuffer, body.bytes.byteOffset, body.bytes.byteLength) }, options, this.maxResponseBytes);
    const answer = this.json<BytesResponse>(response.path, response.text);
    if (answer.sha256 !== sha256 || answer.bytes !== body.bytes.length) throw new MachineServiceError(`machine-service ${response.path}: the instance stored ${answer.bytes} bytes with SHA-256 ${answer.sha256}, not what was sent`);
    return answer;
  }
  /**
   * Pull one file as bytes, `GET /machines/<name>/files`, into `to`, which
   * must not exist. The bytes stream to disk as they are hashed, so a file of
   * any size needs no memory of its size, and the pull is abandoned only when
   * no byte arrives for its timeout. The file is removed unless the bytes
   * match the digest the instance states (DC-31).
   */
  async pullBytes(vm: string, body: { remote_path: string; to: string } & LeaseIdentity, options: RequestOptions = {}): Promise<BytesResponse> {
    const client = await this.relayFor(vm);
    if (client) {
      try { return await this.relayRead(client, body.remote_path, body.to, options); }
      catch (error) { await rm(body.to, { force: true }); throw error; }
    }
    const hash = createHash("sha256"), file = await open(body.to, "wx", 0o600);
    let bytes = 0;
    try {
      const response = await this.fetchBounded(this.filesPath(vm, body.remote_path, body.lease_id), { method: "GET" }, { ...options, timeoutMs: options.timeoutMs ?? PULL_IDLE_MS }, Number.MAX_SAFE_INTEGER, { idle: true, sink: async chunk => { hash.update(chunk); bytes += chunk.byteLength; await file.write(chunk); } });
      if (response.contentType !== "application/octet-stream") throw new MachineServiceError(`machine-service ${response.path}: expected one file, got ${response.contentType ?? "no content type"}`);
      const digest = hash.digest("hex");
      if (!response.sha256 || digest !== response.sha256.toLowerCase()) throw new MachineServiceError(`machine-service ${response.path}: the bytes' SHA-256 ${digest} differs from the stated ${response.sha256 ?? "none"}`);
      await file.sync(); await file.close();
      return { sha256: digest, bytes };
    } catch (error) {
      await file.close().catch(() => {}); await rm(body.to, { force: true });
      throw error;
    }
  }
  private filesPath(vm: string, remote: string, lease_id?: string): string {
    const query = new URLSearchParams({ ...(lease_id ? { lease_id } : {}), path: remote });
    return `${this.path(vm, "files")}?${query}`;
  }
  private path(vm: string, action?: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(vm)) throw new TypeError("Invalid VM name");
    return `/machines/${encodeURIComponent(vm)}${action ? `/${action}` : ""}`;
  }
  private async request<T>(path: string, body: unknown, options: RequestOptions): Promise<T> {
    const response = await this.fetchBounded(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, options, this.maxResponseBytes);
    return this.json<T>(path, response.text);
  }
  private json<T>(path: string, text: string): T {
    try { return JSON.parse(text) as T; }
    catch (cause) { throw new MachineServiceError(`machine-service ${path}: invalid JSON response`, undefined, undefined, { cause }); }
  }
  /**
   * One request whose answer is read up to `maxBytes`; an error answer is read
   * up to 4 KiB and thrown with its status. With `sink`, a successful answer is
   * handed over chunk by chunk instead of kept; with `idle`, the timeout counts
   * from the last chunk rather than from the start.
   */
  private async fetchBounded(path: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> }, options: RequestOptions, maxBytes: number, stream: { sink?: (chunk: Uint8Array) => Promise<void>; idle?: boolean } = {}) {
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const expire = () => controller.abort(Object.assign(new MachineServiceError(`machine-service ${path} timed out after ${timeoutMs}ms${stream.idle ? " without a byte" : ""}`), { code: "ETIMEDOUT" }));
    let timer = setTimeout(expire, timeoutMs);
    try {
      const response = await this.transport(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(this.environment ? { 'X-VM-Environment-Fingerprint': this.environment.identity.fingerprint } : {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
        redirect: "error", // Do not let a service redirect to another host.
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const bound = response.ok ? maxBytes : Math.min(4096, maxBytes);
      let truncated = false;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (stream.idle) { clearTimeout(timer); timer = setTimeout(expire, timeoutMs); }
            if (response.ok && stream.sink) { size += value.byteLength; await stream.sink(value); continue; }
            const remaining = bound - size;
            chunks.push(value.subarray(0, remaining));
            size += Math.min(value.byteLength, remaining);
            if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
          }
        } finally { reader.releaseLock(); }
      }
      // Only an answer that was kept is decoded: a streamed one never becomes a string, whose length is bounded.
      const bytes = Buffer.concat(chunks), text = bytes.toString("utf8");
      if (!response.ok) throw new MachineServiceError(`machine-service ${path}: HTTP ${response.status}: ${text}${truncated ? " [truncated]" : ""}`, response.status, text);
      if (truncated) throw new MachineServiceError(`machine-service ${path}: response exceeds ${bound} bytes`);
      return { path, bytes, text, contentType: response.headers.get("content-type") ?? undefined, sha256: response.headers.get("x-content-sha256") ?? undefined };
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof MachineServiceError) throw cause;
      throw new MachineServiceError(`machine-service ${path}: request failed${cause instanceof Error ? `: ${cause.message}` : ""}`, undefined, undefined, { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
