import { isIP } from "node:net";
import type { SelectedEnvironment, EnvironmentIdentity } from './environment.js';

/** The daemon's actual record; acquire returns this directly, not a lease wrapper. */
export interface VmLease {
  vm: string;
  lease_id?: string;
  console?: import('./console.js').ConsoleStatus;
  purpose: string;
  image: string;
  image_kind: "macos" | "linux";
  env: string | null;
  state: "pending" | "provisioning" | "running" | "releasing";
  created_at: number;
  ttl_expires_at: number;
  grace_until: number | null;
  warned: boolean;
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
}
export interface AcquireRequest {
  purpose: string;
  image?: string;
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
export type ExecRequest = ({ argv: string[]; script?: never } | { script: string; argv?: never }) & { timeout?: number };
export interface TransferRequest { local_path: string; remote_path: string }
export interface ExecResponse { vm: string; rc: number; output: string }
export interface PushResponse { vm: string; pushed: string; to: string }
export interface PullResponse { vm: string; pulled: string; to: string }
export interface ReleaseResponse { vm: string; released: boolean; reason: string }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface MachineServiceOptions {
  baseUrl?: string;
  environment?: SelectedEnvironment;
  timeoutMs?: number;
  acquireTimeoutMs?: number;
  maxResponseBytes?: number;
}

/** The manager depends on this protocol, not on a concrete transport or hypervisor. */
export type VmBackend = Pick<MachineService, 'baseUrl' | 'health' | 'list' | 'images' | 'applications' | 'get' | 'acquire' | 'exec' | 'push' | 'pull' | 'heartbeat' | 'release'> & Partial<Pick<MachineService, 'acquisitionCapabilities' | 'consoleResolve' | 'consoleOpen' | 'consoleCancel'>>;

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
  return typeof reason === "string" && reason.startsWith("macOS VM limit reached") && outcome !== "uncertain";
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
function isLease(value: unknown): value is VmLease {
  if (!record(value)) return false;
  return ["vm", "purpose", "image"].every(k => typeof value[k] === "string" && value[k] !== "")
    && ["macos", "linux"].includes(String(value.image_kind))
    && ["pending", "provisioning", "running", "releasing"].includes(String(value.state))
    && ["created_at", "ttl_expires_at"].every(k => typeof value[k] === "number" && Number.isFinite(value[k]))
    && ["cpu", "memory_mb", "disk_gb", "grace_until"].every(k => value[k] === null || typeof value[k] === "number")
    && ["env", "ip"].every(k => value[k] === null || typeof value[k] === "string")
    && typeof value.warned === "boolean";
}

export class MachineService {
  readonly baseUrl: string;
  private readonly environment?: SelectedEnvironment;
  private readonly timeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: MachineServiceOptions | string = {}) {
    if (typeof options === "string") options = { baseUrl: options };
    this.environment = options.environment;
    const url = new URL(options.baseUrl ?? options.environment?.profile.vmServiceUrl ?? "http://localhost:6240");
    if (options.environment && url.origin !== new URL(options.environment.profile.vmServiceUrl).origin) throw new TypeError('Backend endpoint does not match the selected environment');
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("machine-service baseUrl must be a loopback HTTP(S) origin without credentials, path, query or fragment");
    }
    this.baseUrl = url.origin;
    this.timeoutMs = positive(options.timeoutMs ?? 660_000, "timeoutMs");
    this.acquireTimeoutMs = positive(options.acquireTimeoutMs ?? 3_600_000, "acquireTimeoutMs");
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
  }

  health(options: RequestOptions = {}): Promise<{ ok: boolean; service: string; environment?: EnvironmentIdentity }> {
    return this.request("/health", undefined, options);
  }
  list(options: RequestOptions = {}): Promise<MachineList> { return this.request("/machines", undefined, options); }
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
  get(vm: string, options: RequestOptions = {}): Promise<VmSnapshot> {
    return this.request(this.path(vm), undefined, options);
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
  exec(vm: string, body: ExecRequest, options: RequestOptions = {}): Promise<ExecResponse> {
    return this.request(this.path(vm, "exec"), body, options);
  }
  push(vm: string, body: TransferRequest, options: RequestOptions = {}): Promise<PushResponse> {
    return this.request(this.path(vm, "push"), body, options);
  }
  pull(vm: string, body: TransferRequest, options: RequestOptions = {}): Promise<PullResponse> {
    return this.request(this.path(vm, "pull"), body, options);
  }
  heartbeat(vm: string, body: { ttl_hours?: number } = {}, options: RequestOptions = {}): Promise<VmLease & { ttl_hours_remaining: number }> {
    return this.request(this.path(vm, "heartbeat"), body, options);
  }
  release(vm: string, body: { reason?: string } = {}, options: RequestOptions = {}): Promise<ReleaseResponse> {
    return this.request(this.path(vm, "release"), body, options);
  }
  private path(vm: string, action?: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(vm)) throw new TypeError("Invalid VM name");
    return `/machines/${encodeURIComponent(vm)}${action ? `/${action}` : ""}`;
  }
  private async request<T>(path: string, body: unknown, options: RequestOptions): Promise<T> {
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new MachineServiceError(`machine-service ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.environment ? { 'X-VM-Environment-Fingerprint': this.environment.identity.fingerprint } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error", // Do not let a loopback service redirect to remote hosts.
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const bound = response.ok ? this.maxResponseBytes : Math.min(4096, this.maxResponseBytes);
      let truncated = false;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const remaining = bound - size;
            chunks.push(value.subarray(0, remaining));
            size += Math.min(value.byteLength, remaining);
            if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
          }
        } finally { reader.releaseLock(); }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!response.ok) throw new MachineServiceError(`machine-service ${path}: HTTP ${response.status}: ${text}${truncated ? " [truncated]" : ""}`, response.status, text);
      if (truncated) throw new MachineServiceError(`machine-service ${path}: response exceeds ${bound} bytes`);
      try { return JSON.parse(text) as T; }
      catch (cause) { throw new MachineServiceError(`machine-service ${path}: invalid JSON response`, undefined, undefined, { cause }); }
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof MachineServiceError) throw cause;
      throw new MachineServiceError(`machine-service ${path}: request failed`, undefined, undefined, { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
