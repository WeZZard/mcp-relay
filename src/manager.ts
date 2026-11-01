import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, cp, access, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GUEST_NETWORKS, capacityWait, guestNetwork, maxGuests, relayStateRoot, type GuestNetwork } from './config.js';
import { fileURLToPath } from 'node:url';
import { Relay, type Session, type SnapshotsRequest, type StepDescription } from '@wezzard/relay-driver-host-sdk';
import { MachineService, MachineServiceError, expectMachineService, type VmLease, type VmBackend } from './machine-service.js';
import { canonicalPath, environmentVariables, matchesEnvironment, selectedEnvironment, type SelectedEnvironment } from './environment.js';
import { homedir } from 'node:os';
import { Registry, type RegistryRow } from './registry.js';
import { Transfer, assertHostPath, transientTransfer, type FileFact, type VmChannel } from './transfer.js';
import type { ArchiveEntry, ArchiveRequest } from './archive.js';
import { VmTransport } from './transport.js';
import { command, hash, jsonFile, within } from './util.js';
import { deliverPackage, type DeliveryResult } from './package.js';
import { probeLocal } from './probe.js';
import { acquireOwnerLock, type OwnerLock } from './owner-lock.js';
import { searchCatalog, validateCatalog, type SearchQuery } from './search.js';
import { recordSearch } from './search-diagnostics.js';
import { acquisitionCapabilities, consoleStatus, type ConsoleStatus } from './console.js';
import { ImageStore, imageCapability, type ImageDescriptor, type ImageTarget, type ImageResult } from './images.js';
import { DownloadQueue, type DownloadJob, type StepResult } from './downloads.js';
import type { LocalSource } from './transfer.js';
import { refreshEvidenceState } from './evidence-merge.js';
import { findDurableOwner, type DiscoveryMode, type DurableOwner } from './discovery.js';
import type { Advertised } from './mdns.js';
import { durableCapture, type PermissionAnswer } from './capture-gate.js';

export interface Extraction { path: string; name: string }
/** Exactly one of `image`, a VM image, and `machine`, a durable machine's name (DC-29). */
export interface AcquireInput { task: string; image?: string; machine?: string; extractions: Extraction[]; ttlHours?: number; fullWorkspace?: boolean; env?: string; vnc?: boolean }
/**
 * `guest` names the guest a call acts on (DC-20). The MCP tools require it;
 * a caller of the manager itself may leave it out while the session holds
 * exactly one guest.
 */
export interface GuestSelector { guest?: string }
export interface ConsoleAttemptInput extends GuestSelector { console_id: string; attempt_id: string }
export interface ConsoleOpenInput extends ConsoleAttemptInput { userRequested: true; reason: string; expected: string }
export interface StageInput extends GuestSelector { resetRecording?: boolean; workspace?: string; files?: Array<{ local: string; path: string }>; nodePath?: string; cuaDriver?: string }
/**
 * One run. `because`, `step` and `snapshots` are optional: whatever is left
 * out is derived from the call (see `derive`). Every run is a script, with
 * no kind (DC-26): `inline` says whether the script is `code` or the host
 * file `localPath`, and only a `shell` script may be `diagnostic`.
 */
export interface RunInput extends GuestSelector { because?: string; timeoutMs?: number; diagnostic?: boolean; step?: Partial<StepDescription>; snapshots?: SnapshotsRequest; inline: boolean; localPath?: string; language: 'shell' | 'javascript' | 'typescript' | 'python'; code?: string }
/** The file name extension of a script file the relay uploads, by language. */
const SCRIPT_EXTENSIONS = { shell: 'sh', javascript: 'js', typescript: 'ts', python: 'py' } as const;
/** The backend a guest's lease lives on: the loopback instance and its Tart store, or for a durable machine the owner's origin and instance ID (DC-29). */
interface BackendBinding { machine_id?: string; endpoint: string; tartHome?: string; environmentFingerprint?: string; instance?: string }
/** One guest's durable ownership record, `guests/<guest>/lease.json` in the session's state directory. */
interface Enclosure {
  backend?: BackendBinding;
  /** The VM image, or for a durable machine its name. */
  purpose: string; task: string; image: string; project: string; startedAt: string;
  /** A durable machine's name; absent for a VM (docs/durable-machines.md). */
  machine?: string;
  /** Why a durable machine's runs take snapshots or not, from its cua-driver daemon (DC-32). */
  captureReason?: string;
  /** The durable release's hygiene record (DC-33). */
  hygiene?: unknown;
  guestRoot: string; hostRoot: string; ttlHours: number; extractions: Extraction[]; fullWorkspace: boolean;
  lease?: VmLease; row: RegistryRow; staged: boolean; node?: string; cuaDriver?: string; sessionId?: string;
  /** Whether the image lists capture software, decided once at the first stage; absent on older leases, which capture. */
  capture?: boolean;
  failed?: string; lastError?: string; released?: boolean; delivered?: DeliveryResult; acquisitionInFlight?: boolean;
  active?: boolean; guestState?: string; expiresAt?: number;
  /** Counter for derived step IDs. */
  runSeq?: number;
  previousEvidence?: Array<{ path: string; sessionId: string; guestState?: string }>;
  pendingReset?: { id: string; from: string; fromSession: string; to: string };
  consoleObservation?: ConsoleStatus;
  consoleAttempt?: { console_id: string; attempt_id: string; status: string };
  consoleAttemptIds?: string[];
  /** The host was at capacity and the acquisition waits to be asked again (DC-22). */
  capacityWait?: { since: string; attempts: number; reason: string };
}
/** What relay_status, relay_probe and every guest result report about one guest. */
export interface GuestStatus {
  /** The guest's name in this session; absent only when the session holds no guest. */
  guest?: string;
  task?: string; backend?: BackendBinding; vm?: string; lease_id?: string; console?: ConsoleStatus; consoleAttempt?: { console_id: string; attempt_id: string; status: string };
  purpose?: string; staged?: boolean; lastError?: string; released?: boolean; active: boolean; guestState?: string;
  previousEvidence?: Array<{ path: string; sessionId: string; guestState?: string }>; recordingResetPending?: boolean; expiresAt?: number; output?: string;
  downloads?: ReturnType<DownloadQueue['counts']>;
  /** The acquisition waits for a host at capacity: since when, how many refusals, and machine-service's reason (DC-22). */
  waitingForCapacity?: { since: string; attempts: number; reason: string };
}
/** A run's result: its execution identity and outcome, the after-snapshot delivery, and kind-specific facts. */
export interface RunResult {
  executionId: string | null;
  outcome: { kind: 'completed'; exitStatus: { code: number | null; signal: string | null } } | { kind: 'refused' | 'uncertain'; diagnostic: string };
  imageDelivery: Omit<ImageResult, 'content'> & { content?: ImageResult['content'] };
  [key: string]: any;
}
export interface ManagerOptions {
  sessionId: string; project: string; stateRoot?: string; outputRoot?: string; registry?: Registry; vm?: VmBackend; environment?: SelectedEnvironment; tartHome?: string; tartPath?: string; runtimeBundle?: string; heartbeatMs?: number; verifyDestroyed?: (vm: string) => Promise<boolean>;
  /** How far each renewal extends the lease at machine-service; default RENEWAL_WINDOW_MS. */
  renewalWindowMs?: number;
  /** The network every guest is acquired on; default MCP_RELAY_GUEST_NETWORK, read at each acquisition (DC-17). */
  guestNetwork?: GuestNetwork;
  /** The most guests the session holds at once; default MCP_RELAY_MAX_GUESTS (DC-20). */
  maxGuests?: number;
  /** How long an acquisition waits for a host at capacity, in ms; default MCP_RELAY_CAPACITY_WAIT seconds, 0 for not at all (DC-22). */
  capacityWaitMs?: number;
  /** How often a waiting acquisition is asked again; default CAPACITY_RETRY_MS (DC-22). */
  capacityRetryMs?: number;
  /** How long relay_stage waits for the guest's cua-driver to take a screenshot, in ms; default CAPTURE_READY_WAIT_MS (DC-24). */
  captureReadyWaitMs?: number;
  /** How often relay_stage asks the guest's cua-driver again; default CAPTURE_READY_RETRY_MS (DC-24). */
  captureReadyRetryMs?: number;
  /** How instances are found; default MACHINE_SERVICE_DISCOVERY, `bonjour` when unset (DC-35). */
  discovery?: DiscoveryMode;
  /** Test seam: a Bonjour browse. */
  bonjourBrowse?: () => Promise<Advertised[]>;
  /** The Consul agent that lists machine-service instances in Consul mode; default CONSUL_HTTP_ADDR (DC-29). */
  consul?: string;
  /** Test seam: the backend for an instance discovery found. */
  durableBackend?: (origin: string) => VmBackend;
  /** Test seam: Consul's answer. */
  consulFetch?: (url: string) => Promise<unknown>;
  /** Test seam: free space of the evidence volume; default `fs.promises.statfs`. */
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  /** Background downloads a run may leave queued; default DOWNLOAD_BOUND. */
  downloadBound?: number;
  /** Waits between a background download's attempts; default DOWNLOAD_RETRY_DELAYS_MS. */
  downloadRetryDelaysMs?: readonly number[];
}
/**
 * H6: the relay tracks each lease's own deadline (startedAt + ttlHours) and
 * renews machine-service only this far ahead, never past that deadline, so a
 * client that crashes leaves its VM leased for at most this window. A
 * graceful pause renews once for the rest of the TTL (docs/lifecycle-fixes.md).
 */
export const RENEWAL_WINDOW_MS = 15 * 60000;
/** machine-service refuses a ttl_hours below 0.1 h. */
const MIN_RENEWAL_MS = 0.1 * 3600000;
/** Default wait, in milliseconds, from the end of a run to its after-snapshot; a run that does not know what it changed on screen gives native animations and dialogs this long. */
export const DEFAULT_AFTER_INTERVAL_MS = 500;
/**
 * Capture software: the catalog ids of cua-driver, on macOS and on Linux. A
 * run takes snapshots only when the lease's image lists one of them
 * (docs/guest-code-runs.md §3).
 */
export const CAPTURE_SOFTWARE: readonly string[] = ['bundle:com.trycua.driver', 'dpkg:cua-driver'];
/** A durable guest's root, under its lease's workspace, which machine-service removes at release (DC-31). */
export const durableRoot = (workspace: string, purpose: string) => join(workspace, 'work', `mcp-relay-${purpose}`);
/** Background step downloads a run may leave queued before it waits for the oldest (DC-4). */
export const DOWNLOAD_BOUND = 64;
/** Waits before a background download's second and third attempts (DC-5). */
export const DOWNLOAD_RETRY_DELAYS_MS = [1000, 3000] as const;
/** How often an acquisition waiting for capacity is asked again (DC-22). */
export const CAPACITY_RETRY_MS = 15000;
/** An image starts cua-driver's daemon at login, which can follow the guest's readiness by tens of seconds (DC-24). */
export const CAPTURE_READY_WAIT_MS = 120000;
export const CAPTURE_READY_RETRY_MS = 2000;
/** A task slug, as relay_acquire takes it. */
const TASK = /^[a-z0-9][a-z0-9-]{0,35}$/;
/** A guest name: the task and a counter, such as `login-test-2`; it names the guest's folder in the state directory (DC-20). */
export const GUEST_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
type DisplayTarget = Extract<ImageTarget, { source: 'display' }>;
/** One step download serves both of the step's images (AD-3). */
const downloadKey = (target: Pick<DisplayTarget, 'sessionId' | 'executionId'>) => `${target.sessionId}/${target.executionId}`;
const stepId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Wait for every one of several operations, then throw the first failure, so one guest's failure never cuts another's operation short. */
async function settleEach(work: Array<Promise<unknown>>) {
  const failed = (await Promise.allSettled(work)).find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
/**
 * The server's MCP `instructions`: the rules that cut across all fourteen
 * tools rather than belonging to one of them (see each tool's own
 * description for its specific contract). A compact version of the same
 * rules also lives in the `relay_probe` and `relay_acquire` descriptions,
 * because not every MCP client surfaces server instructions to the model.
 */
export const instructions = 'This server offers fourteen tools for guests, machines that run the work you choose to run there: VMs from an image, or durable machines, real Macs named with `machine`: relay_search, relay_probe, relay_acquisition_capabilities, relay_acquire, relay_stage, the run tool relay_script, relay_image, relay_extract, relay_finish, relay_release, relay_console_resolve, relay_console_open, relay_console_cancel and relay_status. relay_script runs a shell, JavaScript, TypeScript or Python script, given inline or as a project file; a command is a shell script, and the script drives whatever the image lists, such as cua-driver, Playwright or Chrome DevTools, through their own libraries or command lines. Staging needs only Node.js in the guest, and a run takes before and after snapshots only when the image lists capture software (cua-driver). Evidence is automatic, and a run\'s after-image is returned as pending and downloaded in the background, so call relay_image with the imageId when you need to see it. Acquire one guest for each machine your work needs; several guests may run at once, up to the session\'s limit that relay_status reports. relay_acquire answers each guest\'s name, `guest`, and every call that acts on a guest names it with `guest`. Calls on different guests run at the same time; calls on one guest keep their order. Work each guest in order: relay_probe, then relay_acquire, then relay_stage, then relay_script, then relay_image or relay_extract as needed, then relay_finish or relay_release; finishing or releasing one guest leaves the others running. Always call relay_finish or relay_release explicitly for every guest before you return an answer; ending the session never finishes a guest: it pauses lease renewal and keeps the VMs or, where the relay is set up to, releases them, and the backend\'s own expiry is the last-resort safeguard. A refused, uncertain or nonzero operation keeps the VM so you can diagnose and submit a corrected operation; never replay input whose effect is uncertain. A tool result, an attached image or a verified evidence package, is evidence for a human reviewer, never the review itself. A durable machine is a real Mac on the home network, leased whole for one session: it is not isolated from the home network, a CI job may share its desktop, and its runs take snapshots only while its cua-driver daemon holds Screen Recording. The relay never targets its own host\'s display and offers no video or spawn API. Every tool\'s text result is capped at 50 KiB / 2000 lines; a larger result is retained whole in a local file the result names.';

/** relay_release's diagnostic when this session owns no lease. */
export const NO_OWNED_LEASE = 'This session owns no lease: it holds no guest, so nothing was released. Each server process has its own session identity (a new random one unless MCP_RELAY_SESSION sets it); a lease acquired under another identity is not visible here. Restart the server with that MCP_RELAY_SESSION to reconcile and release it, or let the backend TTL expire it.';

/**
 * One relay session: its identity, owner lock and state directory, and the
 * guests it holds (DC-20). Each guest keeps its own lease, heartbeat,
 * evidence, downloads, recording session, owner lock and registry row in a
 * `Guest`; calls on one guest run in order, calls on different guests at the
 * same time. The session's own queue orders what spans guests: loading the
 * state, admitting an acquisition, search, the host probe and shutdown.
 */
export class RelayManager {
  readonly vm: VmBackend;
  readonly environment?: SelectedEnvironment;
  readonly tartHome: string;
  readonly tartPath: string;
  readonly registry: Registry;
  readonly root: string;
  /** The most guests this session holds at once (DC-20). */
  readonly maxGuests: number;
  /** How long an acquisition waits for a host at capacity, and how often it is asked again (DC-22). */
  readonly capacityWaitMs: number;
  readonly capacityRetryMs: number;
  /** Aborted when the session starts to end, so a wait for capacity stops at once (DC-22). */
  readonly ending = new AbortController();
  /** The guests the session holds, by name, in the order they were acquired. */
  private guests = new Map<string, Guest>();
  private queue: Promise<unknown> = Promise.resolve();
  private loading?: Promise<void>;
  private loaded = false;
  private ownerLock?: OwnerLock;
  /** Set once shutdown has paused the guests: no new acquisition or guest operation starts. */
  shuttingDown = false;
  constructor(readonly options: ManagerOptions) {
    this.environment = options.environment ?? selectedEnvironment();
    this.tartHome = this.environment?.profile.tartHome ?? canonicalPath(options.tartHome ?? process.env.TART_HOME ?? join(process.env.HOME ?? homedir(), '.tart'));
    this.tartPath = this.environment?.profile.tartPath ?? options.tartPath ?? process.env.TART ?? 'tart';
    if (this.environment && ((options.stateRoot && canonicalPath(options.stateRoot) !== this.environment.profile.relayStateDir) || (options.tartHome && canonicalPath(options.tartHome) !== this.tartHome) || (options.tartPath && canonicalPath(options.tartPath) !== this.tartPath))) throw new Error('Injected paths conflict with the selected environment');
    this.maxGuests = options.maxGuests ?? maxGuests();
    if (!Number.isSafeInteger(this.maxGuests) || this.maxGuests < 1) throw new Error('maxGuests must be a positive integer');
    this.capacityWaitMs = options.capacityWaitMs ?? capacityWait() * 1000;
    this.capacityRetryMs = options.capacityRetryMs ?? CAPACITY_RETRY_MS;
    if (!Number.isFinite(this.capacityWaitMs) || this.capacityWaitMs < 0 || !Number.isFinite(this.capacityRetryMs) || this.capacityRetryMs <= 0) throw new Error('capacityWaitMs must be nonnegative and capacityRetryMs positive');
    this.vm = options.vm ?? new MachineService({ baseUrl: this.environment?.profile.vmServiceUrl ?? process.env.MCP_RELAY_URL, environment: this.environment });
    this.registry = options.registry ?? new Registry(this.environment ? { managedRoot: this.environment.profile.relayStateDir } : {});
    this.root = join(this.environment?.profile.relayStateDir ?? options.stateRoot ?? relayStateRoot(), hash(options.sessionId).slice(0, 32));
  }
  /** The instance that owns a durable machine, found as machctl finds it (DC-29). */
  durableOwner(machine: string): Promise<DurableOwner> {
    return findDurableOwner(machine, { local: this.vm, ...(this.options.discovery ? { mode: this.options.discovery } : {}), ...(this.options.bonjourBrowse ? { browse: this.options.bonjourBrowse } : {}), ...(this.options.consul ? { consul: this.options.consul } : {}), ...(this.options.durableBackend ? { backend: this.options.durableBackend } : {}), ...(this.options.consulFetch ? { fetchJson: this.options.consulFetch } : {}) });
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  /**
   * Load the session's state, then restore every guest it holds: reconcile
   * each with the backend and reattach its recording. The first failure is
   * thrown once every guest has been tried, and the owner locks are given up,
   * so a session that cannot be restored here, such as one bound to another
   * environment, is left for a process that can.
   */
  async initialize() {
    await this.load();
    const guests = [...this.guests.values()];
    try { await settleEach(guests.map(guest => guest.serialized(() => guest.restore()))); }
    catch (error) { await this.unload(guests); throw error; }
  }
  /**
   * Take the session's owner lock and read the guests it holds, host-only:
   * no backend call. A guest is reconciled when a call first acts on it.
   */
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return this.loading ??= this.readState().then(() => { this.loaded = true; }, error => { this.loading = undefined; throw error; });
  }
  private async readState() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!this.ownerLock) this.ownerLock = await acquireOwnerLock(join(this.root, 'owner.lock')); // Stable inode; never unlink.
    const guests: Guest[] = [];
    try {
      const folder = join(this.root, 'guests');
      for (const name of await readdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; })) {
        if (!GUEST_NAME.test(name)) continue;
        const record = await readRecord(join(folder, name, 'lease.json'));
        if (!record) continue;
        const guest = new Guest(this, name, record); await guest.lock(); guests.push(guest);
      }
      // A relay before DC-20 kept its one enclosure in `lease.json`: it becomes a guest, named from its task.
      const legacy = await readRecord(join(this.root, 'lease.json'));
      if (legacy) {
        if (!guests.some(guest => guest.enclosure?.purpose === legacy.purpose)) {
          const taken = new Set(guests.map(guest => guest.name));
          const guest = new Guest(this, await this.freeName(TASK.test(legacy.task) ? legacy.task : 'guest', taken), legacy);
          await guest.lock(); await guest.save(); guests.push(guest);
        }
        await jsonFile(join(this.root, 'lease.json'), null);
      }
    } catch (error) {
      for (const guest of guests) await guest.unlock().catch(() => {});
      await this.unlock(); throw error;
    }
    guests.sort((a, b) => (a.enclosure!.startedAt ?? '').localeCompare(b.enclosure!.startedAt ?? '') || a.name.localeCompare(b.name, undefined, { numeric: true }));
    this.guests = new Map(guests.map(guest => [guest.name, guest]));
  }
  /** The first `<task>-<n>` the session has never used: a guest's folder stays when it is released, so a name is never reused. */
  private async freeName(task: string, taken: ReadonlySet<string> = new Set()) {
    for (let n = 1; ; n++) {
      const name = `${task}-${n}`;
      if (taken.has(name) || this.guests.has(name)) continue;
      if (await access(join(this.root, 'guests', name)).then(() => true, () => false)) continue;
      return name;
    }
  }
  private held() { return this.guests.size ? [...this.guests.values()].map(guest => guest.enclosure?.capacityWait ? `${guest.name} (waiting for capacity)` : guest.name).join(', ') : 'none'; }
  /** The guest a call names; without a name, the session's only guest. */
  private named(guest?: string): Guest {
    if (guest === undefined) {
      if (this.guests.size === 1) return [...this.guests.values()][0]!;
      if (!this.guests.size) throw new Error('No active lease: this session holds no guest; use relay_acquire');
      throw new Error(`Name the guest this call acts on: this session holds ${this.held()}`);
    }
    const found = typeof guest === 'string' && GUEST_NAME.test(guest) ? this.guests.get(guest) : undefined;
    if (!found) throw new Error(`This session holds no guest named ${JSON.stringify(guest)}; it holds ${this.held()}. relay_acquire answers each guest's name.`);
    return found;
  }
  /**
   * Run once the state is loaded: at once when it already is, so calls take
   * their guest's order in the order they were made.
   */
  private whenLoaded<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.loaded) return this.load().then(fn);
    try { return fn(); } catch (error) { return Promise.reject(error); }
  }
  /** Run one operation on a named guest, in that guest's order. */
  private onGuest<T>(guest: string | undefined, fn: (guest: Guest) => Promise<T>): Promise<T> {
    return this.whenLoaded(() => { const found = this.named(guest); return found.serialized(() => fn(found)); });
  }
  /** A guest whose record is gone, after its release or its verified destruction, leaves the session. */
  async forget(guest: Guest) {
    if (this.guests.get(guest.name) === guest) this.guests.delete(guest.name);
    guest.stopTimer(); await guest.unlock();
  }
  binding(): BackendBinding { return { endpoint: this.vm.baseUrl, tartHome: this.tartHome, ...(this.environment ? { environmentFingerprint: this.environment.identity.fingerprint } : {}) }; }
  bindingMatches(e: Enclosure): boolean {
    // A durable machine's owner is found again from Consul when the guest is reconciled (DC-29).
    if (e.machine) return !!e.backend?.endpoint && !!e.backend.instance;
    if (e.backend) {
      const expected = this.binding();
      return Object.keys(e.backend).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => e.backend![key as keyof BackendBinding] === value);
    }
    // Only the original default deployment may adopt pre-binding legacy state.
    return !this.environment && new URL(this.vm.baseUrl).origin === 'http://localhost:6240' && this.tartHome === canonicalPath(join(process.env.HOME ?? homedir(), '.tart'));
  }
  async assertBackend() {
    if (!this.environment) return;
    if (new URL(this.vm.baseUrl).origin !== new URL(this.environment.profile.vmServiceUrl).origin) throw new Error('Injected backend endpoint does not match selected environment');
    const health = await this.vm.health({ timeoutMs: 5000 });
    expectMachineService(health, this.vm.baseUrl);
    if (!health.ok || !matchesEnvironment(health.environment, this.environment)) throw new Error('machine-service environment identity mismatch; no lease operation was performed');
  }
  private async unlock() { if (this.ownerLock) { await this.ownerLock.release(); this.ownerLock = undefined; } }
  /** Every guest the session holds, with its state; `active` is true while any guest's lease is being renewed. */
  status() {
    const guests = [...this.guests.values()].map(guest => guest.status());
    return { active: guests.some(guest => guest.active), guests, maxGuests: this.maxGuests };
  }
  /** One guest's status; without a name, the only guest's, or `active: false` when the session holds none. */
  guestStatus(guest?: string): GuestStatus {
    if (guest === undefined && !this.guests.size) return { active: false };
    return this.named(guest).status();
  }
  search(query: SearchQuery, signal?: AbortSignal, toolCallId?: string) { return this.serialized(async () => {
    // Deliberately bypass init/recovery, ownership locks, probes and lease APIs.
    let result;
    try {
      signal?.throwIfAborted();
      result = searchCatalog(await this.vm.applications({ signal }), query);
    } catch (error) {
      await recordSearch(this.root, query, { error }, { toolCallId });
      throw error;
    }
    await recordSearch(this.root, query, { result }, { toolCallId });
    return result;
  }); }
  probe(scope: 'host' | 'guest' = 'host', guest?: string) {
    if (scope === 'guest') return this.onGuest(guest, found => found.guarded(undefined, () => found.probe()));
    return this.serialized(async () => {
      // The host facts list every guest the session holds, after a restart too; loading is host-only.
      let ownership: string | undefined;
      try { await this.load(); } catch (error) { ownership = `This session's guests could not be loaded: ${message(error)}`; }
      const local = await probeLocal();
      let relay;
      try { const [health, images, leases] = await Promise.all([this.vm.health({ timeoutMs: 5000 }), this.vm.images({ timeoutMs: 5000 }), this.vm.list({ timeoutMs: 5000 })]); relay = { reachable: health.ok, images, capacity: leases.limits }; }
      catch (error) { relay = { reachable: false, diagnostic: String(error) }; }
      const facts = { scope: 'host', local, relay, environment: this.environment?.identity, owned: this.status(), ...(ownership ? { ownership } : {}), capabilities: { image: imageCapability } };
      await jsonFile(join(this.root, 'probes', `${Date.now()}-${randomUUID()}.json`), facts);
      // Each guest's evidence records the host facts its agent saw.
      for (const found of this.guests.values()) await found.log('probe', undefined, facts).catch(() => {});
      return facts;
    });
  }
  async readAcquisitionCapabilities(signal?: AbortSignal) {
    signal?.throwIfAborted(); await this.assertBackend();
    if (!this.vm.acquisitionCapabilities) throw new Error('Backend lacks acquisition-capabilities; upgrade machine-service for VNC');
    return acquisitionCapabilities(await this.vm.acquisitionCapabilities({ signal, timeoutMs: 10000 }));
  }
  acquisitionCapabilities(signal?: AbortSignal) { return this.serialized(() => this.readAcquisitionCapabilities(signal)); }
  consoleResolve(signal?: AbortSignal, guest?: string) { return this.onGuest(guest, found => found.resolveConsole(signal)); }
  consoleOpen(input: ConsoleOpenInput, signal?: AbortSignal) {
    return this.onGuest(input.guest, found => {
      this.reason(input.reason); this.reason(input.expected);
      if (input.userRequested !== true) throw new Error('Opening requires an explicit user request');
      return found.consoleOperation('open', input, signal);
    });
  }
  consoleCancel(input: ConsoleAttemptInput, signal?: AbortSignal) { return this.onGuest(input.guest, found => found.consoleOperation('cancel', input, signal)); }
  /**
   * A host path the relay reads: relative to the project folder, or absolute
   * and already in it; no symlink at or below the folder (DC-15).
   */
  async projectPath(path: string, label: string) {
    if (typeof path !== 'string' || !path) throw new Error(`${label} must name a host path in the project folder`);
    const project = resolve(this.options.project), target = resolve(project, path);
    try { await assertHostPath(project, target); }
    catch (error) { throw new Error(`${label} ${path} must lie in the project folder ${project}, without symlinks: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    return target;
  }
  reason(because: string) { if (typeof because !== 'string' || !because.trim() || because.length > 4000) throw new Error('reason must be nonblank and at most 4000 characters'); }
  /**
   * Admit one acquisition in the session's order: check its input and the
   * guest limit, then name the guest. The acquisition itself runs in the new
   * guest's own order, so it neither waits for nor holds up the other guests.
   */
  async acquire(input: AcquireInput, signal?: AbortSignal) {
    const { guest, network } = await this.serialized(async () => {
      await this.load(); signal?.throwIfAborted(); await this.assertBackend();
      if (this.shuttingDown) throw new Error('Relay manager is shutting down');
      // The host names the guest's network; the agent cannot (DC-17).
      const network = this.options.guestNetwork ?? guestNetwork();
      if (!(GUEST_NETWORKS as readonly string[]).includes(network)) throw new Error(`guestNetwork must be nat or internet, not ${JSON.stringify(network)}`);
      if (typeof input.task !== 'string' || !TASK.test(input.task)) throw new Error('task must be a lowercase slug (1–36 chars)');
      if ((input.image === undefined) === (input.machine === undefined)) throw new Error('relay_acquire takes exactly one of image, a VM image, and machine, a durable machine\'s name');
      if (input.machine !== undefined && (typeof input.machine !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.machine))) throw new Error('machine must be a durable machine\'s name, as machctl list shows it');
      if (input.machine !== undefined && input.vnc) throw new Error('A durable machine has no console: view it with Screen Sharing, outside the relay; nothing was acquired');
      if (!Array.isArray(input.extractions) || input.extractions.length > 100) throw new Error('Declare up to 100 extractions before work');
      const names = new Set<string>();
      for (const extraction of input.extractions) {
        within('/workspace', extraction.path);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(extraction.name) || names.has(extraction.name)) throw new Error('Extraction names must be unique safe basenames');
        if (extraction.name === 'full-workspace') throw new Error('full-workspace is a reserved extraction name');
        names.add(extraction.name);
      }
      const ttlHours = input.ttlHours ?? 4;
      if (!Number.isFinite(ttlHours) || ttlHours < 0.1 || ttlHours > 720) throw new Error('ttlHours must be 0.1–720');
      if (input.vnc !== undefined && typeof input.vnc !== 'boolean') throw new Error('vnc must be boolean');
      if (this.guests.size >= this.maxGuests) throw new Error(`This session already holds ${this.guests.size} guest${this.guests.size === 1 ? '' : 's'}, the most MCP_RELAY_MAX_GUESTS allows (${this.maxGuests}): ${this.held()}. Finish or release one of them before acquiring another; nothing was acquired.`);
      const guest = new Guest(this, await this.freeName(input.task));
      this.guests.set(guest.name, guest);
      return { guest, network };
    });
    return guest.serialized(() => guest.acquire(input, network, signal));
  }
  renewalWindowMs() {
    const ms = this.options.renewalWindowMs ?? RENEWAL_WINDOW_MS;
    if (!Number.isFinite(ms) || ms < MIN_RENEWAL_MS) throw new Error('renewalWindowMs must be at least 0.1 hours');
    return ms;
  }
  stage(input: StageInput, signal?: AbortSignal) { return this.onGuest(input.guest, guest => guest.guarded(signal, () => guest.stage(input, signal))); }
  run(input: RunInput, signal?: AbortSignal): Promise<RunResult> {
    return this.onGuest(input.guest, guest => {
      if (input.because !== undefined) this.reason(input.because);
      return guest.guarded<RunResult>(signal, () => guest.run(input, signal));
    });
  }
  image(target: ImageTarget, signal?: AbortSignal, guest?: string): Promise<ImageResult> {
    const deadline = Date.now() + 90000;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    if (bounded.aborted) return Promise.resolve({ status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded before starting.' });
    // Verified local image recovery must not depend on a reachable guest: loading the state is host-only.
    return this.whenLoaded(() => {
      let found: Guest;
      try { found = this.named(guest); }
      catch (error) { return Promise.resolve<ImageResult>({ status: 'stale-reference', diagnostic: `${message(error)} A closed guest's delivered originals stay readable with the host read tool.` }); }
      return found.serialized(() => found.image(target, bounded, deadline));
    });
  }
  extract(names: string[], signal?: AbortSignal, guest?: string) { return this.onGuest(guest, found => found.guarded(signal, () => found.extract(names))); }
  finish(signal?: AbortSignal, guest?: string) { return this.onGuest(guest, found => found.guarded(signal, () => found.drained(() => found.finish()))); }
  release(guest?: string) {
    return this.whenLoaded(async () => {
      // Never guess at another session's lease: say plainly that nothing was released.
      if (!this.guests.size) { await this.assertBackend(); return { active: false as const, ownedLease: false as const, released: false as const, diagnostic: NO_OWNED_LEASE }; }
      const found = this.named(guest);
      return found.serialized(() => found.release());
    });
  }
  async settle() { return this.serialized(() => settleEach([...this.guests.values()].map(guest => guest.serialized(() => guest.pause('Agent settled; VM retained until explicit release or backend expiration'))))); }
  /**
   * Shutdown's last resort when an operation does not settle: pause every
   * guest's renewal and release the owner locks without waiting for the
   * queues. The process exits right after, so an abandoned operation cannot
   * save again.
   */
  async pauseNow(reason: string) {
    this.shuttingDown = true; this.ending.abort();
    const guests = [...this.guests.values()];
    try {
      await settleEach(guests.map(async guest => {
        guest.closed = true; void guest.downloads.close(false);
        await guest.pause(`${reason}; an in-flight operation did not settle and was abandoned`);
      }));
    } finally { await this.unload(guests); }
  }
  /**
   * The session ends: each guest's renewal pauses after the operation its
   * queue already holds, so a finish or release the client already sent
   * completes first. The VMs are retained for an explicit finish or release.
   */
  async cleanup(reason: string) { this.ending.abort(); return this.serialized(async () => {
    const guests = [...this.guests.values()];
    try {
      await settleEach(guests.map(guest => guest.serialized(async () => {
        guest.closed = true;
        await guest.downloads.close(true); await guest.pause(reason);
        await guest.session?.close(); guest.session = undefined; guest.transport = undefined;
      })));
    } finally { this.shuttingDown = true; await this.unload(guests); }
  }); }
  /**
   * The session ends with MCP_RELAY_ON_EXIT=release (DC-21): release every
   * guest it holds, those an earlier process of the session left included,
   * each through its own release path after the operation its queue already
   * holds. A guest whose release fails keeps its record; its renewal stops
   * without a final renewal, so its lease ends within its last window.
   */
  async releaseAll(reason: string) { this.ending.abort(); return this.serialized(async () => {
    this.shuttingDown = true;
    await this.load();
    const guests = [...this.guests.values()];
    try { await settleEach(guests.map(guest => guest.serialized(() => guest.releaseOnExit(reason)))); }
    finally { await this.unload(guests); }
  }); }
  /**
   * releaseAll's last resort when it does not settle in time: release each
   * guest still held at once, without waiting for its queue or pulling more
   * evidence, in one bounded attempt. The process exits right after.
   */
  async releaseNow(reason: string) {
    this.shuttingDown = true; this.ending.abort();
    const guests = [...this.guests.values()];
    try { await settleEach(guests.map(guest => guest.releaseDirect(`${reason}; an in-flight operation did not settle and was abandoned`))); }
    finally { await this.unload(guests); }
  }
  /** Give up the owner locks. The guests stay listed for status; a later call loads the state again. */
  private async unload(guests: Guest[]) {
    for (const guest of guests) { guest.stopTimer(); await guest.unlock().catch(() => {}); }
    this.loaded = false; this.loading = undefined;
    await this.unlock();
  }
}

async function readRecord(path: string): Promise<Enclosure | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/**
 * One guest of a relay session (DC-20): its lease and heartbeat, its
 * evidence folder, its background downloads, its recording session and
 * transport, its owner lock and registry row. Its operations run in its own
 * order; its finish or release leaves the session's other guests running.
 */
class Guest {
  /** `guests/<name>` in the session's state directory: the guest's `lease.json` and `owner.lock`. */
  readonly dir: string;
  enclosure?: Enclosure;
  session?: Session;
  transport?: VmTransport;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeating = false;
  private renewal?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private ownerLock?: OwnerLock;
  /** Reconciled with the backend since it was loaded; a guest acquired in this process starts so. */
  private restored: boolean;
  /** Shutdown has paused this guest: operations queued after it are refused. */
  closed = false;
  /** After-image downloads, outside the serialized section (docs/screenshot-delivery.md §10). */
  readonly downloads: DownloadQueue;
  /** A durable machine's owner, once found (DC-29). */
  private owner?: VmBackend;
  /** The backend this guest's lease lives on: the loopback instance, or a durable machine's owner. */
  get vm(): VmBackend {
    const e = this.enclosure;
    if (!e?.machine) return this.m.vm;
    if (this.owner) return this.owner;
    if (!e.backend?.endpoint || e.backend.endpoint === this.m.vm.baseUrl) return this.owner = this.m.vm;
    throw new Error(`The owner of durable machine ${e.machine} has not been found again in this process; nothing was sent`);
  }
  /**
   * machine-service as the guest's only channel. Every call names the lease's
   * `lease_id` (DC-30); on a durable machine every file goes as bytes (DC-31).
   */
  get channel(): VmChannel {
    const identity = () => { const id = this.enclosure?.lease?.lease_id; return id ? { lease_id: id } : {}; };
    const durable = !!this.enclosure?.machine;
    return {
      exec: async (name, argv, timeoutMs = 180000, options) => {
        const result = await this.vm.exec(name, { argv, timeout: Math.ceil(timeoutMs / 1000), ...identity() }, { timeoutMs: options?.timeoutMs ?? timeoutMs + 30000, signal: options?.signal });
        return { stdout: result.output, stderr: result.output, code: result.rc };
      },
      push: async (name, local_path, remote_path) => {
        if (!durable) return this.vm.push(name, { local_path, remote_path, ...identity() });
        if (!this.vm.pushBytes) throw new Error('Backend lacks byte transfers; upgrade machine-service');
        return this.vm.pushBytes(name, { remote_path, bytes: await readFile(local_path), ...identity() });
      },
      pull: async (name, remote_path, local_path, options) => {
        if (!durable) return this.vm.pull(name, { remote_path, local_path, ...identity() }, options);
        if (!this.vm.pullBytes) throw new Error('Backend lacks byte transfers; upgrade machine-service');
        // As machine-service's path-based pull does, a pull replaces the file in place.
        await rm(local_path, { force: true });
        await this.vm.pullBytes(name, { remote_path, to: local_path, ...identity() }, options);
        return { vm: name, pulled: remote_path, to: local_path };
      },
    };
  }
  /** Find a durable machine's owner again, and refuse when its origin or instance changed (DC-29). */
  private async findOwner(e: Enclosure, force = false) {
    if (!e.machine || (this.owner && !force)) return;
    try {
    const owner = await this.m.durableOwner(e.machine);
    if (e.backend?.endpoint && (owner.origin !== e.backend.endpoint || owner.instance !== e.backend.instance)) throw new Error(`Durable machine ${e.machine} is now listed by ${owner.origin} (${owner.instance}), not by ${e.backend.endpoint} (${e.backend.instance}) where this guest leased it; ownership retained, nothing was sent`);
    this.owner = owner.backend;
    } catch (error) { await this.unknownOwner(e, error); }
  }
  private async unknownOwner(e: Enclosure, cause: unknown): Promise<never> {
    e.guestState = 'unknown';
    const error = new Error(`Cannot confirm durable machine ${e.machine}: ${message(cause)}; ownership retained, guest state unknown`, { cause });
    e.lastError = error.message; await this.save(); throw error;
  }
  /** A durable 404 proves nothing: rediscover and inspect the owner's inventory (DC-36). */
  private async leaseRecord(e: Enclosure) {
    try { return await this.vm.get(e.machine ?? e.lease!.vm, { timeoutMs: 10000 }); }
    catch (error) {
      if (!e.machine || !(error instanceof MachineServiceError) || error.status !== 404) throw error;
      await this.findOwner(e, true);
      const record = (await this.vm.list({ timeoutMs: 10000 })).machines[e.machine];
      if (record?.kind !== 'durable') throw new Error(`Cannot read the record of durable machine ${e.machine}; ownership retained, guest state unknown`);
      return record;
    }
  }
  constructor(readonly m: RelayManager, readonly name: string, record?: Enclosure) {
    this.dir = join(m.root, 'guests', name);
    if (record) { this.enclosure = record; record.active = false; }
    this.restored = !record;
    this.downloads = new DownloadQueue({ bound: m.options.downloadBound ?? DOWNLOAD_BOUND, record: job => this.recordDownload(job) });
  }
  serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  async lock() {
    if (this.ownerLock) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.ownerLock = await acquireOwnerLock(join(this.dir, 'owner.lock')); // Stable inode; never unlink.
  }
  async unlock() { const lock = this.ownerLock; this.ownerLock = undefined; await lock?.release(); }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
  async save() { await jsonFile(join(this.dir, 'lease.json'), this.enclosure ?? null); }
  /** Reconcile a guest loaded from the state directory with the backend, and reattach its recording; once. */
  async restore() {
    if (this.restored) return;
    if (this.enclosure) {
      await this.reconcile();
      if (this.enclosure?.staged && !this.enclosure.delivered) {
        try { await this.attach(); }
        catch (error) { await this.fail(new Error(`Recording session restoration failed; diagnostic repair remains available: ${String(error)}`)); }
      }
    }
    this.restored = true;
  }
  private assertBinding() {
    if (this.enclosure && !this.m.bindingMatches(this.enclosure)) throw new Error('Owned lease belongs to a different or unknown VM environment; select its original environment before operating on it');
  }
  status(): GuestStatus {
    const e = this.enclosure;
    return e ? { guest: this.name, task: e.task, backend: e.backend, vm: e.lease?.vm, lease_id: e.lease?.lease_id, console: e.consoleObservation, consoleAttempt: e.consoleAttempt, purpose: e.purpose, staged: e.staged, lastError: e.lastError ?? e.failed, released: e.released, active: e.active ?? false, guestState: e.guestState ?? 'unknown', previousEvidence: e.previousEvidence, recordingResetPending: !!e.pendingReset, expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at, output: e.hostRoot, downloads: this.downloads.counts(), ...(e.capacityWait ? { waitingForCapacity: e.capacityWait } : {}) } : { guest: this.name, active: false };
  }
  private async reconcile() {
    const e = this.enclosure; if (!e) return;
    this.assertBinding(); await this.m.assertBackend(); await this.findOwner(e);
    e.backend ??= this.m.binding();
    if (!e.lease) {
      const matches = Object.values((await this.vm.list({ timeoutMs: 10000 })).machines).filter(v => v.purpose === e.purpose);
      if (matches.length !== 1) throw new Error(`Cannot reconcile acquisition for ${e.purpose}; ownership retained, never automatically reacquire`);
      e.lease = matches[0]; e.acquisitionInFlight = false;
      if (e.machine && e.lease.workspace) e.guestRoot = durableRoot(e.lease.workspace, e.purpose);
    }
    try {
      const lease = await this.leaseRecord(e);
      // A durable machine outlives its leases: a record that names another lease, or none, means ours has ended (DC-33).
      if (e.machine && lease.lease_id !== e.lease.lease_id) {
        await this.m.registry.remove(e.row);
        await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, machine: e.machine, released: true, reason: 'the durable machine no longer names this lease', finishedAt: new Date().toISOString() });
        this.enclosure = undefined; await this.save(); await this.m.forget(this); return;
      }
      if (lease.purpose !== e.purpose || (e.lease.lease_id && lease.lease_id !== e.lease.lease_id)) throw new Error('Lease ownership identity mismatch');
      if (e.lease.console?.console_id && lease.console?.console_id !== e.lease.console.console_id) throw new Error('Console instance identity mismatch during lease reconciliation');
      if (lease.console) {
        lease.console = consoleStatus(lease.console);
        if (lease.console.status === 'revoked') e.consoleObservation = lease.console;
      }
      e.lease = lease; e.guestState = lease.state; e.expiresAt = lease.ttl_expires_at;
      if (e.failed) { e.lastError = e.failed; delete e.failed; }
      await this.save();
    } catch (error) {
      e.guestState = 'unknown';
      if (!e.machine && error instanceof MachineServiceError && error.status === 404 && await this.destroyed(e.lease.vm)) {
        await this.m.registry.remove(e.row);
        await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, vm: e.lease.vm, released: true, reason: 'backend lease absent and destruction verified', finishedAt: new Date().toISOString() });
        this.enclosure = undefined; await this.save(); await this.m.forget(this); return;
      }
      await this.save(); throw error;
    }
  }
  private async attach() {
    const e = this.current();
    if (!e.sessionId || !e.node) throw new Error('Persisted staged session lacks runtime identity');
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(this.transfer(), e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver!);
    this.transport.capture = e.capture !== false;
    this.session = await relay.attach(e.sessionId, this.transport);
  }
  /**
   * relay_probe scope=guest: what the guest has, as facts, without installing
   * or starting anything: whether each relay_script language's runtime runs,
   * and the software the image lists in the catalog (DC-23).
   */
  async probe() {
    const e = this.current();
    const checks = [];
    // Only Node.js is required, by staging; the other runtimes are facts (DC-13). `/bin/sh` has no portable --version, so it runs `exit 0`.
    for (const [name, language, argv] of [['node', 'javascript', [e.node ?? 'node', '--version']], ['tsx', 'typescript', ['tsx', '--version']], ['python3', 'python', ['python3', '--version']], ['sh', 'shell', ['/bin/sh', '-c', 'exit 0']]] as const) {
      const required = name === 'node';
      try { const r = await this.channel.exec(e.lease!.vm, [...argv], 10000); checks.push({ name, language, required, ...r, ready: r.code === 0 }); }
      catch (error) { checks.push({ name, language, required, ready: false, diagnostic: String(error) }); }
    }
    // Without tsx, TypeScript runs with the guest Node.js's own type stripping, 22.6 or later (DC-25).
    const tsx = checks[1] as { ready: boolean; runsWith?: string }, nodeVersion = /^v(\d+)\.(\d+)/.exec(String((checks[0] as { stdout?: string }).stdout ?? ''));
    if (!tsx.ready && nodeVersion && (Number(nodeVersion[1]) > 22 || (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) >= 6))) Object.assign(tsx, { ready: true, runsWith: 'Node.js type stripping' });
    let software: { image?: string; machine?: string; applications?: unknown[]; software?: unknown; diagnostic?: string };
    // A durable machine reports its own software in its capabilities (MM-3).
    if (e.machine) software = { machine: e.machine, software: (await this.vm.get(e.lease!.vm, { timeoutMs: 10000 })).capabilities?.software ?? null };
    else try {
      const catalog: unknown = await this.vm.applications({ timeoutMs: 10000 }); validateCatalog(catalog);
      const listed = catalog.images.find(image => image.image === e.image);
      software = listed ? { image: e.image, applications: listed.applications } : { image: e.image, applications: [], diagnostic: `The catalog does not list ${e.image}.` };
    } catch (error) { software = { image: e.image, diagnostic: `The image catalog could not be read: ${message(error)}` }; }
    const snapshots = e.capture === undefined && !e.staged ? { taken: null, reason: e.machine ? 'Decided at relay_stage: runs take snapshots only when the machine\'s cua-driver daemon holds Screen Recording.' : 'Decided at relay_stage: runs take snapshots only when the image lists capture software (cua-driver).' } : this.snapshotFacts(e);
    const facts = { scope: 'guest', guest: this.name, observedAt: new Date().toISOString(), owned: this.status(), checks, software, snapshots, note: 'A ready runtime means its --version, or for /bin/sh `exit 0`, exited 0. Listed software is what the catalog says the image holds; it never proves that a program runs, that a browser renders on the display or that capture works.', captureVerified: false, browserVerified: false };
    await this.log('guest-readiness', undefined, facts); return facts;
  }
  private async consoleOwner(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.m.shuttingDown || this.closed) throw new Error('Relay manager is shutting down');
    await this.restore(); await this.reconcile();
    const e = this.current();
    if (!e.lease!.lease_id) throw new Error('Legacy lease lacks console identity; no automatic retrofit is available');
    return e;
  }
  async resolveConsole(signal?: AbortSignal) {
    const e = await this.consoleOwner(signal);
    if (!this.vm.consoleResolve) throw new Error('Backend lacks console API; upgrade machine-service');
    let observation: ConsoleStatus;
    try { observation = consoleStatus(await this.vm.consoleResolve(e.lease!.vm, { lease_id: e.lease!.lease_id! }, { signal, timeoutMs: 10000 })); }
    catch (error) {
      if (e.consoleObservation && e.consoleObservation.status !== 'revoked') e.consoleObservation = { ...e.consoleObservation, status: 'unknown' };
      await this.save(); throw error;
    }
    this.assertConsoleIdentity(observation, e);
    if (e.lease!.console?.console_id && observation.console_id !== e.lease!.console.console_id) throw new Error('Console instance identity mismatch');
    e.consoleObservation = observation;
    if (e.consoleAttempt && observation.attempt?.attempt_id === e.consoleAttempt.attempt_id && observation.console_id === e.consoleAttempt.console_id) e.consoleAttempt.status = observation.attempt.status;
    await this.save(); return observation;
  }
  private assertConsoleIdentity(observation: ConsoleStatus, e: Enclosure) {
    if (observation.vm !== e.lease!.vm || observation.lease_id !== e.lease!.lease_id) throw new Error('Console lease identity mismatch');
    const fingerprint = this.m.environment?.identity.fingerprint ?? e.lease!.console?.environment_fingerprint ?? null;
    if (observation.environment_fingerprint !== fingerprint) throw new Error('Console environment identity mismatch');
  }
  async consoleOperation(operation: 'open' | 'cancel', input: ConsoleAttemptInput | ConsoleOpenInput, signal?: AbortSignal) {
    if (![input.console_id, input.attempt_id].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(v))) throw new Error('Invalid console or attempt identity');
    const resolved = await this.resolveConsole(signal), e = this.current();
    if (!e.lease!.console?.console_id) throw new Error('This lease has no acquired console; automatic VNC retrofit is forbidden');
    if (resolved.console_id !== input.console_id) throw new Error('Console instance identity mismatch');
    const method = operation === 'open' ? this.vm.consoleOpen : this.vm.consoleCancel;
    if (!method) throw new Error('Backend lacks console API; upgrade machine-service');
    if (operation === 'open') {
      if (resolved.viewer_location !== 'service-host') throw new Error('Only a viewer on the declared service host is supported; no remote-client viewer fallback');
      if (e.lease!.state !== 'running' || !Number.isFinite(e.lease!.ttl_expires_at) || e.lease!.ttl_expires_at <= Date.now() / 1000) throw new Error('Console lease is not running or has expired');
      if (resolved.status !== 'ready') throw new Error('Console is not ready or access was revoked; no automatic recovery');
      if (e.consoleAttempt && e.consoleAttempt.attempt_id === input.attempt_id) return { ...resolved, retainedAttempt: e.consoleAttempt, replayed: false, screenshotEvidence: false };
      if (e.consoleAttemptIds?.includes(input.attempt_id)) throw new Error('Console attempt ID was already used; historical launches are never replayed');
      if ((e.consoleAttemptIds?.length ?? 0) >= 64) throw new Error('Console attempt limit reached for this enclosure');
      if (e.consoleAttempt && !['cancelled', 'closed', 'failed', 'expired'].includes(e.consoleAttempt.status)) throw new Error('Previous console attempt remains active or uncertain; resolve or cancel it before requesting a new attempt');
      if (resolved.attempt && !['cancelled', 'closed', 'failed'].includes(resolved.attempt.status)) throw new Error('Backend console attempt remains active or uncertain; resolve or cancel it first');
    }
    const body = { lease_id: e.lease!.lease_id!, console_id: input.console_id, attempt_id: input.attempt_id };
    if (operation === 'cancel' && e.consoleAttempt && e.consoleAttempt.attempt_id !== input.attempt_id && !['cancelled', 'closed', 'failed', 'expired'].includes(e.consoleAttempt.status)) throw new Error('Cancel must identify the active or uncertain owned attempt');
    e.consoleAttemptIds = [...new Set([...(e.consoleAttemptIds ?? []), input.attempt_id])];
    e.consoleAttempt = { console_id: input.console_id, attempt_id: input.attempt_id, status: 'uncertain' };
    // Persist before dispatch. Restore and repeated open never replay a launch.
    await this.save();
    await this.log(`console-${operation}-intent`, 'reason' in input ? input.reason : undefined, { ...body, ...('expected' in input ? { expected: input.expected } : {}), screenshotEvidence: false });
    try {
      const observation = consoleStatus(await method.call(this.vm, e.lease!.vm, body, { signal, timeoutMs: 30000 }));
      this.assertConsoleIdentity(observation, e);
      if (observation.console_id !== body.console_id || observation.attempt?.attempt_id !== body.attempt_id) throw new Error('Console response identity mismatch');
      e.consoleObservation = observation; e.consoleAttempt.status = observation.attempt.status;
      await this.save(); await this.log(`console-${operation}`, undefined, observation);
      return { ...observation, screenshotEvidence: false, leaseReleased: false };
    } catch {
      await this.save();
      throw new Error(`Console ${operation} outcome unknown; ownership retained. Resolve or cancel attempt ${input.attempt_id}; never automatically replay opening.`);
    }
  }
  private current() { this.assertBinding(); if (!this.enclosure?.lease || this.enclosure.released) throw new Error(`No active lease for guest ${this.name}; use relay_acquire`); return this.enclosure; }
  private transfer() { const e = this.current(); if (!e.node) throw new Error('Stage runtime first'); return new Transfer(this.channel, e.lease!.vm, e.node, { guestRoot: e.guestRoot, hostTempRoot: join(this.m.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event), onArchiveFallback: event => this.log('archive-fallback', undefined, event) }); }
  async log(kind: string, because?: string, details: unknown = {}) {
    if (because !== undefined) this.m.reason(because);
    const e = this.enclosure;
    if (e) await jsonFile(e.delivered ? join(`${e.hostRoot}.lifecycle-events`, `${Date.now()}-${randomUUID()}.json`) : join(e.hostRoot, 'host', 'events', `${Date.now()}-${randomUUID()}.json`), { kind, because, at: new Date().toISOString(), details });
  }
  /**
   * The acquisition, in this guest's own order. Its ownership intent is
   * persisted and registered before machine-service is asked. A refusal before
   * that, or machine-service's own refusal, leaves the session without the guest;
   * any other failure keeps the guest's record for reconciliation.
   */
  async acquire(input: AcquireInput, network: GuestNetwork, signal?: AbortSignal) {
    const ttlHours = input.ttlHours ?? 4;
    let owner: DurableOwner | undefined;
    try {
      if (this.m.shuttingDown || this.closed) throw new Error('Relay manager is shutting down');
      if (input.machine) owner = await this.m.durableOwner(input.machine);
      else {
        const image = input.image!, images = await this.vm.images({ timeoutMs: 5000, signal });
        if (!images.images[image]?.base_available) throw new Error(`Image unavailable: ${image}`);
        if (input.vnc) {
          const capabilities = await this.m.readAcquisitionCapabilities(signal);
          if (!capabilities.options.vnc.backends[images.images[image]!.kind].available) throw new Error('VNC backend unavailable for this image OS; ordinary acquisition was not attempted');
        }
      }
      await this.lock();
    } catch (error) { await this.m.forget(this); throw error; }
    const purpose = `relay-${input.task}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const stamp = startedAt.slice(0, 19).replace(/[T:]/g, '-') + '-Z';
    const project = this.m.options.project, environment = this.m.environment;
    const hostRoot = join(this.m.options.outputRoot ?? resolve(project, 'relay-evidence'), purpose);
    const subject = input.machine ?? input.image!;
    const row: RegistryRow = { machine: owner ? `${input.machine} (durable, ${owner.origin}; ${purpose})` : environment ? `${environment.profile.vmServiceUrl} (${environment.profile.id}; ${purpose})` : `127.0.0.1 (machine-service ${purpose})`, os: owner ? 'macos (durable)' : subject, taskName: purpose, agent: `mcp-relay ${this.m.options.sessionId}`, project: resolve(project), startDate: stamp };
    // A durable guest's root moves under the lease's workspace once the lease names it (DC-31).
    const e: Enclosure = this.enclosure = { backend: owner ? { endpoint: owner.origin, instance: owner.instance } : this.m.binding(), purpose, task: input.task, image: subject, ...(input.machine ? { machine: input.machine } : {}), project, startedAt, guestRoot: `/var/tmp/${stamp}-mcp-relay-${purpose}`, hostRoot, ttlHours, extractions: input.extractions, fullWorkspace: input.fullWorkspace ?? false, row, staged: false };
    if (owner) this.owner = owner.backend;
    let refused = false;
    try { await this.save(); }
    catch (error) { this.enclosure = undefined; await this.m.forget(this); throw error; }
    try {
      await this.m.registry.add(row);
      await this.log('acquire-intent', undefined, { ...input, guest: this.name, network });
      try { await cp(join(this.m.root, 'probes'), join(hostRoot, 'host', 'probes'), { recursive: true, errorOnExist: true, force: false, filter: source => !source.endsWith('.tmp') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // A host at capacity refuses before it reserves anything, so the same acquisition is asked again until the wait runs out (DC-22).
      let firstRefusal: number | undefined, granted = 0;
      for (;;) {
        e.acquisitionInFlight = true; await this.save();
        const asked = Date.now();
        try {
          const ttl_hours = Math.min(this.m.renewalWindowMs(), ttlHours * 3600000) / 3600000;
          // A durable acquisition names the machine and nothing a running Mac cannot apply (DM-3).
          e.lease = await this.vm.acquire(input.machine ? { purpose, machine: input.machine, env: input.env ?? 'none', ttl_hours } : { purpose, image: input.image, env: input.env ?? 'none', ttl_hours, wait: true, network, ...(input.vnc === undefined ? {} : { vnc: input.vnc }) }, { signal });
          if (e.machine) e.guestRoot = durableRoot(e.lease.workspace!, purpose);
          e.acquisitionInFlight = false; granted = asked; break;
        } catch (error) {
          if (signal?.aborted && error === signal.reason) e.acquisitionInFlight = false;
          // machine-service refused it: nothing was acquired, and the refusal passes through (DC-20).
          else if (error instanceof MachineServiceError && error.status !== undefined && error.status >= 400 && error.status < 500) { e.acquisitionInFlight = false; refused = true; }
          if (!refused || !(error instanceof MachineServiceError && error.capacity) || this.m.capacityWaitMs <= 0) throw error;
          firstRefusal ??= asked;
          await this.waitForCapacity(e, error, firstRefusal, signal);
          refused = false;
        }
      }
      const waitedForCapacityMs = firstRefusal === undefined ? 0 : granted - firstRefusal;
      if (e.capacityWait) { delete e.capacityWait; await this.log('capacity-granted', undefined, { waitedForCapacityMs }); }
      if (e.lease?.console) {
        e.lease.console = consoleStatus(e.lease.console);
        e.consoleObservation = e.lease.console;
      }
      await this.save(); // keep identity even if registration or cancellation fails
      if (input.vnc && (!e.lease?.lease_id || !e.lease.console?.console_id || e.lease.console.status !== 'ready')) throw new Error('VNC acquisition did not return a ready console and lease identity; ownership retained for reconciliation');
      e.guestState = e.lease!.state;
      e.expiresAt = e.lease!.ttl_expires_at;
      this.startHeartbeat(); await this.save();
      // Cancellation is not a release request (technical design 5.2): a lease
      // that arrived after the caller cancelled stays owned and renewed, and
      // the error says so, so the agent can continue, finish or release it.
      if (signal?.aborted) throw new Error(`${String(signal.reason)}; the acquisition completed after it was cancelled: VM ${e.lease!.vm} is owned by this session as guest ${this.name}, retained and renewed. Continue with relay_stage, or call relay_finish or relay_release, naming guest ${this.name}.`, { cause: signal.reason });
      return { ...this.status(), guestRoot: e.guestRoot, workspace: join(e.guestRoot, 'workspace'), declarations: input.extractions, ...(e.machine ? { machine: e.machine, kind: 'durable' as const, network: 'lan' as const } : { network }), waitedForCapacityMs };
    } catch (error) {
      if (refused && await this.withdraw(error)) throw error;
      await this.fail(error);
      if (!this.enclosure || message(error).includes(`guest ${this.name}`)) throw error;
      throw new Error(`${message(error)}\nGuest ${this.name} keeps this acquisition's ownership record: name it to reconcile, stage or release it.`, { cause: error });
    }
  }
  /**
   * The host is at capacity: wait one retry interval, or what is left of
   * MCP_RELAY_CAPACITY_WAIT, before the acquisition is asked again. Refuses
   * with machine-service's reason and the time waited once the wait has run out,
   * or when the call is cancelled or the session ends (DC-22).
   */
  private async waitForCapacity(e: Enclosure, refusal: MachineServiceError, since: number, signal?: AbortSignal) {
    const waited = Date.now() - since, remaining = this.m.capacityWaitMs - waited;
    const seconds = (ms: number) => Math.round(ms / 100) / 10;
    if (remaining <= 0) throw new Error(`${refusal.message}; waited ${seconds(waited)} s for capacity, the most MCP_RELAY_CAPACITY_WAIT allows (${seconds(this.m.capacityWaitMs)} s), so nothing was acquired`, { cause: refusal });
    const attempts = (e.capacityWait?.attempts ?? 0) + 1;
    if (!e.capacityWait) await this.log('capacity-wait', undefined, { reason: refusal.message, waitMs: this.m.capacityWaitMs, retryMs: this.m.capacityRetryMs });
    e.capacityWait = { since: new Date(since).toISOString(), attempts, reason: refusal.message }; await this.save();
    const stop = AbortSignal.any([...(signal ? [signal] : []), this.m.ending.signal]);
    await new Promise<void>(done => {
      const timer = setTimeout(done, Math.min(this.m.capacityRetryMs, remaining));
      stop.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      if (stop.aborted) { clearTimeout(timer); done(); }
    });
    if (stop.aborted) throw new Error(`${signal?.aborted ? String(signal.reason) : 'The relay session ended'} while the acquisition waited ${seconds(Date.now() - since)} s for capacity (${refusal.message}), so nothing was acquired`, { cause: refusal });
  }
  /**
   * A refused acquisition acquired nothing: once machine-service lists no VM for
   * its purpose, its registry row goes and the guest leaves the session.
   * False when that cannot be established, so the record stays.
   */
  private async withdraw(error: unknown) {
    const e = this.enclosure!;
    try {
      if (Object.values((await this.vm.list({ timeoutMs: 10000 })).machines).some(lease => lease.purpose === e.purpose)) return false;
      await this.m.registry.remove(e.row);
      await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, released: false, acquired: false, reason: 'machine-service refused the acquisition', error: String(error), finishedAt: new Date().toISOString() });
      this.enclosure = undefined; await this.save(); await this.m.forget(this);
      return true;
    } catch { return false; }
  }
  /** Milliseconds left until the lease's own deadline, startedAt + ttlHours. */
  private remainingMs(e: Enclosure) { return Date.parse(e.startedAt) + e.ttlHours * 3600000 - Date.now(); }
  private startHeartbeat() {
    if (this.timer || !this.enclosure?.lease) return;
    // With less than machine-service's minimum renewal left, the lease already
    // expires at its own deadline; there is nothing left to renew.
    if (this.remainingMs(this.enclosure) < MIN_RENEWAL_MS) { this.enclosure.active = false; return; }
    this.enclosure.active = true;
    const ms = this.m.options.heartbeatMs ?? Math.min(60000, this.m.renewalWindowMs() / 3);
    this.timer = setInterval(() => { void this.heartbeat(); }, ms); this.timer.unref();
  }
  private heartbeat(): Promise<void> {
    const e = this.enclosure;
    if (!e?.lease || e.released || this.heartbeating) return this.renewal ?? Promise.resolve();
    this.heartbeating = true;
    return this.renewal = this.renew(e, e.lease).finally(() => { this.heartbeating = false; this.renewal = undefined; });
  }
  /** Stop renewing at the lease's own deadline; the VM is retained until the backend expires it. */
  private async stopRenewal(e: Enclosure) {
    this.stopTimer();
    if (this.enclosure !== e || e.released) return;
    e.active = false; await this.save();
    await this.log('renewal-stopped', undefined, { reason: 'the lease reached its own TTL', deadline: new Date(Date.parse(e.startedAt) + e.ttlHours * 3600000).toISOString(), expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at });
  }
  private async renew(e: Enclosure, lease: VmLease) {
    try {
      const remaining = this.remainingMs(e);
      if (remaining < MIN_RENEWAL_MS) { await this.stopRenewal(e); return; }
      this.assertBinding(); await this.m.assertBackend();
      const renewed = await this.vm.heartbeat(lease.vm, { ttl_hours: Math.min(this.m.renewalWindowMs(), remaining) / 3600000, ...(lease.lease_id ? { lease_id: lease.lease_id } : {}) }, { timeoutMs: 10000 });
      if (this.enclosure !== e || e.released) return;
      e.expiresAt = renewed.ttl_expires_at; e.guestState = renewed.state; await this.save();
    }
    catch (error) {
      if (this.enclosure !== e || e.released) return;
      e.lastError = `Heartbeat lost: ${String(error)}`; e.guestState = 'unknown'; await this.save().catch(() => {});
      void this.serialized(async () => {
        if (this.enclosure !== e || e.released) return;
        try { await this.reconcile(); } catch (failure) { await this.log('heartbeat-uncertain', undefined, { error: String(failure) }).catch(() => {}); }
      }).catch(() => {});
    }
  }
  async guarded<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      if (this.m.shuttingDown || this.closed) throw new Error('Relay manager is shutting down');
      await this.restore(); signal?.throwIfAborted();
      if (this.m.shuttingDown || this.closed) throw new Error('Relay manager is shutting down');
      await this.reconcile(); this.current(); this.startHeartbeat();
      const result = await fn(); signal?.throwIfAborted();
      // The operation reached the guest and completed: a paused download worker may go on (AD-4).
      this.downloads.resume();
      return result;
    } catch (error) { await this.fail(error); throw new Error(`${String(error)}\nVM state: ${JSON.stringify(this.status())}`, { cause: error }); }
  }
  async stage(input: StageInput, signal?: AbortSignal) {
    const e = this.current();
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.resetRecording || e.pendingReset) await this.resetRecording();
    if (e.staged && (input.workspace || input.files?.length)) throw new Error('Runtime already staged; use a shell relay_script with diagnostic: true for repairs, or stage with only corrected executable paths');
    // Every host path is checked before anything reaches the guest (DC-15).
    const project = resolve(this.m.options.project);
    const files = [];
    for (const file of input.files ?? []) files.push({ local: await this.m.projectPath(file.local, 'files[].local'), path: file.path });
    const workspace = input.workspace === undefined ? undefined : await this.m.projectPath(input.workspace, 'workspace');
    const bundle = this.m.options.runtimeBundle ?? fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
    await access(bundle);
    // The host decides once per lease whether its runs take snapshots (DC-13).
    if (!e.machine && e.capture === undefined && !e.staged) { e.capture = await this.captureSoftware(e, signal); await this.save(); }
    const node = input.nodePath ?? e.node ?? 'node';
    const transfer = new Transfer(this.channel, e.lease!.vm, node, { guestRoot: e.guestRoot, hostTempRoot: join(this.m.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event), onArchiveFallback: event => this.log('archive-fallback', undefined, event) });
    // Node.js is the only software staging assumes: it runs the relay's own guest code (DC-13).
    try { await transfer.checked([node, '--version']); }
    catch (error) { throw new Error(`relay_stage needs Node.js in the guest to run the relay's own code, and \`${node} --version\` failed: ${error instanceof Error ? error.message : String(error)}. The relay pushes no runtime, so an image without Node.js cannot be staged; choose an image that lists Node.js (relay_search), or name the guest's Node.js with nodePath.`, { cause: error }); }
    const cuaDriver = input.cuaDriver ?? e.cuaDriver ?? (e.lease!.image_kind === 'macos' || e.machine ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver');
    // A durable machine's cua-driver daemon decides at every stage, since its grants can change (DC-32).
    if (e.machine) {
      const decision = await this.durableCapture(e, cuaDriver, signal);
      e.capture = decision.capture; e.captureReason = decision.reason; await this.save();
    }
    if (e.capture !== false) await this.awaitCapture(transfer, e, node, cuaDriver, signal);
    e.node = node; e.cuaDriver = cuaDriver;
    await this.save();
    if (e.staged) { await this.session?.close(); await this.attach(); return { staged: true, workspace: join(e.guestRoot, 'workspace'), owned: this.status(), files: [], extractions: e.extractions, snapshots: this.snapshotFacts(e) }; }
    await transfer.checked(['/bin/mkdir', '-p', join(e.guestRoot, 'workspace'), join(e.guestRoot, 'state')]);
    const staged = [await transfer.pushFile(bundle, join(e.guestRoot, 'receiver.mjs'))];
    for (const file of files) staged.push(await transfer.pushFile(file.local, within(join(e.guestRoot, 'support'), file.path), project));
    if (workspace) staged.push(...await transfer.pushTree(workspace, join(e.guestRoot, 'workspace'), project));
    await this.log('stage', undefined, { files: staged, extractions: e.extractions });
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(transfer, e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver);
    this.transport.capture = e.capture !== false;
    relay.useTransport(() => this.transport!);
    this.session = await relay.start({ taskId: e.purpose, target: `machine-service:${e.machine ? `durable:${e.machine}` : e.lease!.vm}` });
    e.sessionId = this.session.sessionId; e.staged = true; await this.save();
    return { staged: true, workspace: join(e.guestRoot, 'workspace'), files: staged, extractions: e.extractions, snapshots: this.snapshotFacts(e), capabilities: { image: imageCapability } };
  }
  /**
   * Whether the lease's image lists capture software, from the image catalog.
   * A catalog that cannot be read refuses the stage, so a run never loses its
   * snapshots by mistake.
   */
  private async captureSoftware(e: Enclosure, signal?: AbortSignal): Promise<boolean> {
    let catalog: unknown;
    try { catalog = await this.vm.applications({ timeoutMs: 10000, signal }); validateCatalog(catalog); }
    catch (error) { throw new Error(`relay_stage could not read the image catalog to learn whether ${e.image} lists capture software (cua-driver), so nothing was staged: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    const capture = catalog.images.some(image => image.image === e.image && image.applications.some(app => CAPTURE_SOFTWARE.includes(app.id)));
    await this.log('capture-software', undefined, { image: e.image, capture, ids: CAPTURE_SOFTWARE });
    return capture;
  }
  /**
   * Whether a durable machine's runs take snapshots: its capabilities list
   * cua-driver, and the cua-driver daemon, not machine-service, holds Screen
   * Recording (DC-32).
   */
  private async durableCapture(e: Enclosure, cuaDriver: string, signal?: AbortSignal) {
    const software = (await this.vm.get(e.lease!.vm, { timeoutMs: 10000, signal })).capabilities?.software;
    let answer: PermissionAnswer | undefined;
    if (software && typeof software === 'object' && software.cua_driver) {
      try { answer = await this.channel.exec(e.lease!.vm, [cuaDriver, 'permissions', 'status', '--json'], 30000, { signal }); }
      catch (error) { if (signal?.aborted) throw error; answer = { error: message(error) }; }
    }
    const decision = durableCapture(e.machine!, software, answer);
    await this.log('capture-permission', undefined, { machine: e.machine, ...decision, answer });
    return decision;
  }
  /**
   * Waits until the guest's cua-driver takes a screenshot, as each run's
   * snapshots do (DC-24). The image starts its daemon at login, which can
   * follow the guest's readiness, so the first runs would otherwise be refused.
   */
  private async awaitCapture(transfer: Transfer, e: Enclosure, node: string, cuaDriver: string, signal?: AbortSignal) {
    const probe = join(e.guestRoot, 'state', '.stage-capture-probe.png');
    const waitMs = this.m.options.captureReadyWaitMs ?? CAPTURE_READY_WAIT_MS, retryMs = this.m.options.captureReadyRetryMs ?? CAPTURE_READY_RETRY_MS;
    const since = Date.now();
    await transfer.checked(['/bin/mkdir', '-p', join(e.guestRoot, 'state')], undefined, signal);
    for (let attempt = 1; ; attempt++) {
      try {
        await transfer.checked([cuaDriver, 'call', 'get_desktop_state', '--json', JSON.stringify({ screenshot_out_file: probe })], 60000, signal);
        await transfer.checked([node, '-e', 'require("node:fs").rmSync(process.argv[1], { force: true })', probe], undefined, signal);
        if (attempt > 1) await this.log('capture-ready', undefined, { waitedMs: Date.now() - since, attempts: attempt });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        const waited = Date.now() - since;
        if (waited + retryMs > waitMs) throw new Error(`relay_stage waited ${Math.round(waited / 1000)} s for ${e.image}'s cua-driver to take a screenshot, which each run's before and after snapshots need, and it never did: ${message(error)}. Diagnose or start it with a shell relay_script and diagnostic: true, such as \`${cuaDriver} serve\` on Linux, then call relay_stage again.`, { cause: error });
        await new Promise<void>(done => {
          const timer = setTimeout(done, retryMs);
          signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
        });
        if (signal?.aborted) throw error;
      }
    }
  }
  /** What a lease's runs record: snapshots when its image lists cua-driver, none otherwise. */
  private snapshotFacts(e: Enclosure) {
    if (e.machine) return { taken: e.capture === true, reason: e.captureReason ?? 'Decided at relay_stage.' };
    return e.capture === false
      ? { taken: false, reason: `${e.image} lists no capture software (cua-driver), so runs take no snapshots and their records have none.` }
      : { taken: true, reason: e.capture ? `${e.image} lists cua-driver, so each run takes before and after snapshots.` : 'This lease predates the capture decision, so each run takes before and after snapshots.' };
  }
  async run(input: RunInput, signal?: AbortSignal): Promise<RunResult> {
    const e = this.current();
    const timeoutMs = input.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeoutMs must be an integer from 1 to 3600000');
    if (input.diagnostic && input.language !== 'shell') throw new Error('Only a shell script may be diagnostic, because a diagnostic run goes through machine-service without the receiver');
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.diagnostic) return this.diagnostic(input, timeoutMs, signal);
    if (e.pendingReset) throw new Error('Recording reset is pending; retry stage to reconcile it, or use a shell relay_script with diagnostic: true');
    if (!e.staged || !this.session || !this.transport) throw new Error('Use relay_stage before a run, or a shell relay_script with diagnostic: true for setup diagnosis and repair');
    const record = this.derive(e, input);
    await this.save();
    this.transport.because = record.because;
    this.transport.timeoutMs = timeoutMs;
    this.transport.diagnostic = false;
    // A cancelled run stops waiting for the receiver's answer; its outcome is then uncertain, never replayed.
    this.transport.signal = signal;
    const options = { step: record.step, snapshots: record.snapshots, cwd: join(e.guestRoot, 'workspace') };
    // The SDK frames the request; the transport writes it for the guest without a kind (DC-26).
    let result;
    if (input.inline) {
      if (typeof input.code !== 'string' || input.localPath !== undefined) throw new Error('relay_script with inline: true takes the script as code, and no localPath');
      result = await this.session.runCode(input.code, input.language as 'javascript', options);
    } else {
      if (!input.localPath || input.code !== undefined) throw new Error('relay_script with inline: false takes the script file as localPath, and no code');
      const local = await this.m.projectPath(input.localPath, 'localPath');
      result = await this.session.runScript(local, join(e.guestRoot, 'scripts', `${randomUUID()}.${SCRIPT_EXTENSIONS[input.language]}`), input.language as 'javascript', options);
    }
    const outcome = result.outcome;
    if (outcome.kind !== 'completed' || outcome.exitStatus.code !== 0 || outcome.exitStatus.signal) {
      await this.log('execution-failed', record.because, result);
      await this.fail(new Error(`Execution ${result.executionId}: ${JSON.stringify(outcome)}`));
    }
    // The after-image is named, not delivered: the step's evidence downloads in the background (AD-1, AD-2).
    const target: DisplayTarget = { source: 'display', sessionId: e.sessionId!, executionId: result.executionId, phase: 'after' };
    const store = this.imageStore();
    const imageDelivery = await store.pending(target);
    await this.queueDownload(store, target, imageDelivery.status === 'pending', imageDelivery.image);
    const common = { guest: this.name, step: record.step, snapshots: record.snapshots, timeoutMs, evidencePath: e.hostRoot, leaseReleased: !this.enclosure, owned: this.status(), imageDelivery };
    // The guest's bounded output rides along in the receipt the transport filed.
    return { ...result, ...this.transport?.response, ...common };
  }
  /**
   * The step record for a run, from the call itself: a title such as
   * `shell ls -al`, `code (python)` or `script check.py`, an expected result, an input mode, a default
   * after-snapshot wait and a reason. Anything the caller gave overrides it.
   */
  private derive(e: Enclosure, input: RunInput): { because: string; step: StepDescription; snapshots: SnapshotsRequest } {
    const seq = e.runSeq = (e.runSeq ?? 0) + 1;
    const stepId = (prefix: string) => `${prefix.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'run'}-${seq}`;
    // A shell script given inline is usually one command, so its first line names the step, as the command did.
    const firstLine = input.code?.split('\n').find(line => line.trim())?.trim();
    const title = input.step?.title ?? (input.inline ? input.language === 'shell' && firstLine ? `shell ${firstLine}` : `code (${input.language})` : `script ${input.localPath?.split('/').at(-1) ?? ''}`).slice(0, 500);
    const snapshots: SnapshotsRequest = { ...(input.snapshots ?? {}) };
    const group = snapshots.group;
    if (!group ? snapshots.afterIntervalMs === undefined : group.phase === 'last' && group.afterIntervalMs === undefined && snapshots.afterIntervalMs === undefined) Object.assign(snapshots, { afterIntervalMs: DEFAULT_AFTER_INTERVAL_MS });
    return {
      because: input.because ?? `Relay ${title} (no reason given)`.slice(0, 4000),
      step: { id: input.step?.id ?? stepId(input.inline ? 'code' : 'script'), title: title || 'script', expected: input.step?.expected ?? 'Exits with status 0', inputMode: input.step?.inputMode ?? 'ordinary' },
      snapshots,
    };
  }
  private imageStore() {
    const e = this.current();
    return new ImageStore({ owner: this.m.options.sessionId, enclosure: e.purpose, backend: e.backend,
      catalogRoot: join(this.m.root, 'image-catalog', e.purpose), hostRoot: e.hostRoot, guestRoot: e.guestRoot,
      sessionId: e.sessionId, previousEvidence: e.previousEvidence, declarations: e.extractions, transfer: this.transfer(),
      ensureGuest: async (signal, deadline) => {
        const options = { signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) };
        if (this.m.environment) {
          const health = await this.vm.health(options);
          if (!health.ok || !matchesEnvironment(health.environment, this.m.environment)) throw Object.assign(new Error('Selected backend identity changed.'), { code: 'unauthorized-reference' });
        }
        try {
          const lease = await this.vm.get(e.lease!.vm, options);
          if (lease.purpose !== e.purpose || (e.lease!.lease_id && lease.lease_id !== e.lease!.lease_id)) throw Object.assign(new Error('Lease ownership identity changed.'), { code: 'unauthorized-reference' });
        } catch (error) {
          if (error instanceof MachineServiceError && error.status === 404) throw Object.assign(new Error('Saved image guest is no longer available.'), { code: 'stale-reference' });
          throw error;
        }
      } });
  }
  async image(target: ImageTarget, bounded: AbortSignal, deadline: number): Promise<ImageResult> {
    if (bounded.aborted) return { status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded while loading ownership.' };
    this.assertBinding();
    // Verified local image recovery must not depend on a reachable guest. The
    // private catalog still requires this guest's owner lock and record.
    if (!this.enclosure || this.enclosure.released || this.enclosure.delivered) return { status: 'stale-reference', diagnostic: `Guest ${this.name} is closed or sealed; inspect delivered originals with the host read tool.` };
    // AD-3: a background download of this image runs next and is waited for, never transferred twice at once.
    const job = this.downloads.find(target.source === 'reference' ? { imageId: target.imageId } : target.source === 'display' ? { key: downloadKey(target) } : {});
    if (job) {
      this.downloads.promote(job);
      let stop!: () => void;
      const stopped = new Promise<void>(done => { stop = done; bounded.addEventListener('abort', stop, { once: true }); });
      try { await Promise.race([job.done, stopped]); } finally { bounded.removeEventListener('abort', stop); }
      if (bounded.aborted) return { status: 'transfer-failed', ...(job.image ? { image: job.image } : {}), diagnostic: 'Image delivery cancelled or deadline exceeded while its background download was still running.' };
    }
    const store = this.imageStore(), result = await store.get(target, bounded, deadline);
    if (result.status !== 'unauthorized-reference' || target.source !== 'reference') return result;
    // A run named this image, but its step download failed before the catalogue held it (AD-1, AD-4):
    // its display selector checks and catalogues it as the download would have.
    const named = job?.image ?? await this.namedImage(target.imageId);
    if (named?.source !== 'display') return result;
    const resolved = await store.get({ source: 'display', sessionId: named.sessionId!, executionId: named.executionId!, phase: named.phase! }, bounded, deadline);
    return resolved.image && resolved.image.imageId !== target.imageId ? { status: 'integrity-failed', diagnostic: 'The display selector no longer names the referenced image.' } : resolved;
  }
  /** The image a run named with this reference, from the step download records. No guest I/O. */
  private async namedImage(imageId: string): Promise<ImageDescriptor | undefined> {
    const records = join(this.current().hostRoot, 'host', 'evidence-downloads');
    for (const name of (await readdir(records).catch(() => [] as string[])).filter(n => n.endsWith('.json'))) {
      const image = await readFile(join(records, name), 'utf8').then(text => JSON.parse(text)?.image, () => undefined);
      if (image?.imageId === imageId) return image;
    }
    return undefined;
  }
  /** DC-9: every step whose receipt the host holds queues one download of its evidence. */
  private async queueDownload(store: ImageStore, target: DisplayTarget, afterImage: boolean, image?: ImageDescriptor) {
    // Only an open queue takes downloads; otherwise relay_image and the lifecycle operation's archive fetch the files.
    if (this.downloads.state !== 'open') return;
    const e = this.current();
    const requested = await this.stepFiles(e.hostRoot, target.executionId);
    if (!requested) return;
    this.downloads.enqueue({ key: downloadKey(target), ...(image ? { image } : {}), recordPath: join(e.hostRoot, 'host', 'evidence-downloads', `${target.executionId}.json`) },
      signal => this.downloadStep(store, target, requested, afterImage, signal));
    await this.downloads.withinBound();
  }
  /**
   * AD-2: the step's files, relative to the guest root, from the receipt the
   * transport filed on the host. No guest I/O. Undefined without the receipt.
   */
  private async stepFiles(hostRoot: string, executionId: string): Promise<ArchiveRequest[] | undefined> {
    if (!stepId(executionId)) return undefined;
    let receipt: any;
    try { receipt = JSON.parse(await readFile(join(hostRoot, 'host', 'receiver-receipts', `${executionId}.json`), 'utf8')); } catch { return undefined; }
    if (receipt?.executionId !== executionId) return undefined;
    const paths = new Set([`state/receiver/started/${executionId}.json`, `state/receiver/receipts/${executionId}.json`, `state/records/execution/${executionId}.json`]);
    for (const sn of Array.isArray(receipt.imageEvidence?.snapshots) ? receipt.imageEvidence.snapshots : []) {
      if (stepId(sn?.actionId)) paths.add(`state/records/action/${sn.actionId}.json`);
      if (stepId(sn?.sessionId) && stepId(sn?.fileName)) paths.add(`state/snapshots/${sn.sessionId}/${sn.fileName}`);
    }
    return [...paths].map(path => ({ path }));
  }
  /**
   * One step download (AD-2, AD-7, AD-8): the step's files in one archive into
   * `host/steps/<executionId>/`, then the after-image filed from there.
   */
  private async downloadStep(store: ImageStore, target: DisplayTarget, requested: ArchiveRequest[], afterImage: boolean, signal: AbortSignal): Promise<StepResult> {
    const e = this.current(), retryDelaysMs = this.m.options.downloadRetryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(imageCapability.deadlineMs)]);
    const folder = join(e.hostRoot, 'host', 'steps', target.executionId);
    let files: ArchiveEntry[] | undefined;
    for (let attempt = 1; !files; attempt++) {
      try {
        await assertHostPath(e.hostRoot, folder, true); await rm(folder, { recursive: true, force: true });
        files = await this.transfer().pullArchive(e.guestRoot, e.guestRoot, requested, folder, e.hostRoot, { present: true, once: true, signal: bounded });
      } catch (error) {
        const transient = !bounded.aborted && transientTransfer(error);
        if (attempt >= 3 || !transient) return { status: transient || bounded.aborted ? 'transfer-failed' : 'integrity-failed', diagnostic: `Step evidence download failed: ${String(error)}` };
        const wait = retryDelaysMs[attempt - 1] ?? 0;
        await new Promise<void>(done => { const timer = setTimeout(done, wait); bounded.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
      }
    }
    const missing = requested.map(file => file.path).filter(path => !files!.some(file => file.path === path));
    // The after-image is filed from the step folder, so this makes no further guest request (AD-2).
    const result = afterImage ? await store.download(target, signal, { retryDelaysMs }) : { status: 'downloaded' as const };
    return { ...result, files, missing };
  }
  private async recordDownload(job: DownloadJob) {
    const image = job.result?.image ?? job.image;
    await jsonFile(job.recordPath, { status: job.end, key: job.key, ...(image ? { image } : {}), ...(job.result?.files ? { files: job.result.files } : {}), ...(job.result?.missing?.length ? { missing: job.result.missing } : {}), ...(job.result?.diagnostic ? { diagnostic: job.result.diagnostic } : {}), ...(job.result && job.end === 'failed' ? { failure: job.result.status } : {}), queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt });
  }
  /** AD-6: the files the step downloads brought into step folders, by `sha256:bytes`. No guest I/O. */
  private async stepCopies(recording: string, prefix: string): Promise<Map<string, string[]>> {
    const copies = new Map<string, string[]>();
    const records = join(recording, 'host', 'evidence-downloads');
    for (const name of (await readdir(records).catch(() => [] as string[])).filter(n => n.endsWith('.json'))) {
      const executionId = name.slice(0, -5);
      if (!stepId(executionId)) continue;
      let record: any;
      try { record = JSON.parse(await readFile(join(records, name), 'utf8')); } catch { continue; }
      for (const file of Array.isArray(record?.files) ? record.files : []) {
        if (typeof file?.path !== 'string' || !file.path.startsWith(prefix) || typeof file.sha256 !== 'string' || !Number.isSafeInteger(file.bytes)) continue;
        let path: string;
        try { path = within(join(recording, 'host', 'steps', executionId), file.path); } catch { continue; }
        const key = `${file.sha256}:${file.bytes}`;
        copies.set(key, [...(copies.get(key) ?? []), path]);
      }
    }
    return copies;
  }
  /** AD-6: the host files that may already hold a guest state file's bytes. */
  private async localState(recording: string): Promise<LocalSource> {
    const held = await this.imageStore().heldOriginals(recording), steps = await this.stepCopies(recording, 'state/');
    return { root: recording, candidates: file => {
      const key = `${file.sha256}:${file.bytes}`, receipt = /^receiver\/receipts\/([^/]+\.json)$/.exec(file.path)?.[1];
      return [join(recording, 'state', file.path), ...(steps.get(key) ?? []), ...(receipt ? [join(recording, 'host', 'receiver-receipts', receipt)] : []), ...(held.get(key) ?? [])];
    } };
  }
  /** AD-7: the step folders are a staging area; once their files are in the recording's state they go. */
  private async removeStepFolders(recording: string) {
    const steps = join(recording, 'host', 'steps');
    await assertHostPath(recording, steps, true); await rm(steps, { recursive: true, force: true });
  }
  /** A lifecycle operation's gate (AD-5): every download ends before the guest state is touched; the queue opens again after. */
  async drained<T>(fn: () => Promise<T>): Promise<T> {
    await this.downloads.drain();
    try { return await fn(); } finally { this.downloads.reopen(); }
  }
  private resetRecording() { return this.drained(() => this.archiveRecording()); }
  private async archiveRecording() {
    const e = this.current();
    if (!e.staged || !e.sessionId) throw new Error('Recording reset requires a staged recording');
    if (!e.pendingReset) {
      const id = randomUUID();
      e.pendingReset = { id, from: e.hostRoot, fromSession: e.sessionId, to: `${e.hostRoot}-recording-${id.slice(0, 8)}` };
      await this.save();
    }
    const reset = e.pendingReset;
    const transfer = this.transfer();
    const archive = join(e.guestRoot, 'recordings', reset.id);
    // Check the reset marker before selecting the immutable source to preserve.
    const marker = await transfer.checked([e.node!, '-e', 'const fs=require("fs"),p=require("path");console.log(fs.existsSync(p.join(process.argv[1],"recordings",process.argv[2]))?"archived":"current");', e.guestRoot, reset.id]);
    const attempts = `${reset.from}.reset-attempts`;
    const incoming = join(attempts, randomUUID(), 'state');
    const reuse = await this.localState(reset.from);
    await transfer.pullVerified(marker.trim() === 'archived' ? archive : join(e.guestRoot, 'state'), incoming, e.guestRoot, attempts, { beforePull: facts => this.assertFreeSpace(reset.from, facts), reuse });
    if (reuse.reused) await this.log('state-reused', undefined, { files: reuse.reused });
    await this.imageStore().materializeDisplayOriginals(reset.from);
    await refreshEvidenceState(incoming, join(reset.from, 'state'), join(attempts, 'previous'));
    await this.removeStepFolders(reset.from);
    await this.log('recording-reset-intent', undefined, reset);
    // The operation is deliberately idempotent for this persisted reset ID. It
    // never replays input and never deletes old state or an ambiguous live lock.
    await transfer.checked([e.node!, '-e', `const fs=require('fs'),p=require('path');const [root,id]=process.argv.slice(1);if(fs.existsSync(p.join(root,'.receiver-lock')))throw Error('Receiver lock exists; diagnose active execution before recording reset');const state=p.join(root,'state'),archive=p.join(root,'recordings',id),marker=p.join(root,'.recording-reset-'+id+'.json');if(!fs.existsSync(marker)){fs.mkdirSync(p.dirname(archive),{recursive:true});if(!fs.existsSync(archive))fs.renameSync(state,archive);else if(fs.existsSync(state)&&fs.readdirSync(state).length)throw Error('Reset destination is not empty');fs.mkdirSync(state,{recursive:true});fs.writeFileSync(marker,JSON.stringify({id,archive}),{flag:'wx'});}console.log('recording archived');`, e.guestRoot, reset.id]);
    await this.session?.close(); this.session = undefined; this.transport = undefined;
    e.previousEvidence = [...(e.previousEvidence ?? []), { path: reset.from, sessionId: reset.fromSession, guestState: archive }];
    e.hostRoot = reset.to; e.staged = false; e.sessionId = undefined; delete e.pendingReset;
    await this.save();
    await this.log('recording-resumed', undefined, { previousEvidence: e.previousEvidence });
  }
  private async extractInternal(names: string[]) {
    const e = this.current(), transfer = this.transfer(); const results = [];
    for (const name of names) {
      const declaration = e.extractions.find(item => item.name === name);
      if (!declaration) throw new Error(`Undeclared extraction: ${name}`);
      const destination = join(e.hostRoot, 'extractions', name, randomUUID());
      const facts = await transfer.pullVerified(within(join(e.guestRoot, 'workspace'), declaration.path), destination, join(e.guestRoot, 'workspace'), e.hostRoot);
      results.push({ ...declaration, destination, facts });
    }
    await jsonFile(join(e.hostRoot, 'host', 'extractions', `${randomUUID()}.json`), { extractions: results });
    return results;
  }
  async extract(names: string[]) {
    if (this.current().delivered) throw new Error('Evidence already sealed; no further extractions may modify it');
    await this.log('extract', undefined, { names }); return this.extractInternal(names);
  }
  /**
   * finish's extraction: a declared output whose source does not exist in the
   * guest (it was never produced) is recorded as incomplete and skipped, so a
   * retry cannot fail the same way forever. Any other extraction failure, such
   * as a transfer or checksum failure, still fails finish and keeps the VM,
   * because the guest may hold the only good copy (docs/lifecycle-fixes.md).
   */
  private async extractForFinish() {
    const e = this.current(), incomplete: Array<{ name: string; path: string; error: string }> = [];
    for (const extraction of e.extractions) {
      try { await this.extractInternal([extraction.name]); }
      catch (error) {
        const source = within(join(e.guestRoot, 'workspace'), extraction.path);
        const missing = /ENOENT: no such file or directory, lstat '([^']+)'/.exec(String(error))?.[1];
        if (!missing || !(source === missing || source.startsWith(`${missing}/`))) throw error;
        incomplete.push({ name: extraction.name, path: extraction.path, error: String(error) });
        await this.log('extraction-incomplete', undefined, { name: extraction.name, path: extraction.path, missing: true, error: String(error) });
      }
    }
    if (e.fullWorkspace) await this.transfer().pullVerified(join(e.guestRoot, 'workspace'), join(e.hostRoot, 'extractions', 'full-workspace', randomUUID()), e.guestRoot, e.hostRoot);
    return incomplete;
  }
  private async extractAvailable() {
    const e = this.current();
    for (const extraction of e.extractions) {
      try { await this.extractInternal([extraction.name]); }
      catch (error) { await this.log('extraction-incomplete', undefined, { name: extraction.name, error: String(error) }).catch(() => {}); }
    }
    if (e.fullWorkspace) {
      try { await this.transfer().pullVerified(join(e.guestRoot, 'workspace'), join(e.hostRoot, 'extractions', 'full-workspace', randomUUID()), e.guestRoot, e.hostRoot); }
      catch (error) { await this.log('workspace-incomplete', undefined, { error: String(error) }).catch(() => {}); }
    }
  }
  /**
   * A precondition, not a limit (PS-D12): refuse to pull the relay state when
   * the evidence volume cannot hold it, before any byte is pulled, so the disk
   * is not filled part way and the VM stays for a retry after space is freed.
   */
  private async assertFreeSpace(hostRoot: string, facts: FileFact[]) {
    const needed = facts.reduce((sum, fact) => sum + BigInt(fact.bytes), 0n);
    const info = await (this.m.options.statfs ?? (path => statfs(path, { bigint: true })))(hostRoot);
    const free = BigInt(info.bavail) * BigInt(info.bsize);
    if (needed <= free) return;
    const mib = (bytes: bigint) => `${(Number(bytes) / 1048576).toFixed(1)} MiB`;
    throw new Error(`Not enough free space on the evidence volume at ${hostRoot}: the relay state needs ${needed} bytes (${mib(needed)}), ${free} bytes are free (${mib(free)}), short by ${needed - free} bytes (${mib(needed - free)}). Nothing of the state was pulled and the VM is kept; free space on that volume, then call relay_finish again.`);
  }
  private async packageInternal() {
    const e = this.current();
    if (!e.staged || !e.sessionId) throw new Error('No staged session to package');
    const attempts = `${e.hostRoot}.finalization-attempts`;
    const incoming = join(attempts, randomUUID(), 'state');
    const reuse = await this.localState(e.hostRoot);
    await this.transfer().pullVerified(join(e.guestRoot, 'state'), incoming, e.guestRoot, attempts, { beforePull: facts => this.assertFreeSpace(e.hostRoot, facts), reuse });
    if (reuse.reused) await this.log('state-reused', undefined, { files: reuse.reused });
    await this.imageStore().materializeDisplayOriginals(e.hostRoot);
    await refreshEvidenceState(incoming, join(e.hostRoot, 'state'), join(attempts, 'previous'));
    await this.removeStepFolders(e.hostRoot);
    const result = await deliverPackage(e.hostRoot, { packageId: `pkg-${e.purpose}`, sessionId: e.sessionId, taskId: e.purpose });
    e.delivered = result; await this.save(); return result;
  }
  async finish() {
    const e = this.current(); await this.log('finish');
    let incomplete: Array<{ name: string; path: string; error: string }> = [];
    if (!e.delivered) incomplete = await this.extractForFinish();
    const result = e.delivered ?? await this.packageInternal();
    await this.releaseInternal('finished');
    return incomplete.length ? { ...result, incompleteExtractions: incomplete } : result;
  }
  private async fail(error: unknown) {
    const e = this.enclosure; if (!e || !this.m.bindingMatches(e)) return;
    e.lastError = String(error);
    await this.save();
    await this.log('operation-failed', undefined, { error: String(error), leaseRetained: !e.released });
  }
  private async diagnostic(input: RunInput, timeoutMs: number, signal?: AbortSignal) {
    const e = this.current();
    if (input.language !== 'shell' || input.snapshots?.group) throw new Error('A diagnostic run is a shell script and cannot join a snapshot group');
    // machine-service runs the script itself, so a script file is read here and sent as its text (DC-26).
    const script = input.inline ? input.code : await readFile(await this.m.projectPath(input.localPath ?? '', 'localPath'), 'utf8');
    if (typeof script !== 'string') throw new Error('relay_script with inline: true takes the script as code, and no localPath');
    const executionId = `diagnostic-${randomUUID()}`;
    const { guest: _guest, ...requested } = input;
    // The command machine-service runs, recorded with the request so the review names it.
    const argv = e.staged ? ['/bin/sh', '-c', 'cd "$1" || exit; shift; exec "$@"', 'relay-diagnostic', join(e.guestRoot, 'workspace'), '/bin/sh', '-c', script] : ['/bin/sh', '-c', script];
    const request = { executionId, at: new Date().toISOString(), evidenceMode: 'diagnostic', timeoutMs, ...requested, argv };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.request.json`), request);
    let result;
    try {
      // A cancelled command stops waiting for the guest; the outcome is then uncertain.
      const r = await this.channel.exec(e.lease!.vm, argv, timeoutMs, { signal });
      // machine-service returns one stream with stdout and stderr interleaved; report it once, as what it is.
      result = { executionId, outcome: { kind: 'completed' as const, exitStatus: { code: r.code, signal: null } }, output: r.stdout, outputStreams: 'stdout and stderr combined' };
    } catch (error) { result = { executionId, outcome: { kind: 'uncertain' as const, diagnostic: String(error) }, output: '', outputStreams: 'stdout and stderr combined' }; }
    const response = { guest: this.name, ...result, timeoutMs, evidenceMode: 'diagnostic', screenshotEvidence: false, imageDelivery: { status: 'not-requested' as const, diagnostic: 'Diagnostic execution has no screenshot evidence.' }, evidencePath: e.hostRoot, leaseReleased: false, owned: this.status() };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.receipt.json`), response);
    if (result.outcome.kind !== 'completed' || result.outcome.exitStatus.code !== 0) await this.fail(new Error(JSON.stringify(result.outcome)));
    return response;
  }
  /** The session ended with MCP_RELAY_ON_EXIT=release (DC-21): this guest's own release path. */
  async releaseOnExit(reason: string) {
    this.closed = true;
    if (!this.enclosure) return;
    try { await this.log('exit-release', undefined, { reason }); await this.release(); }
    catch (error) { await this.stopOnExit(reason, error); throw error; }
  }
  /** releaseNow's part for this guest: destroy its VM without its queue or more evidence, in one bounded attempt. */
  async releaseDirect(reason: string) {
    this.closed = true; this.stopTimer(); void this.downloads.close(false);
    if (!this.enclosure) return;
    try { await this.log('exit-release', undefined, { reason, direct: true }); await this.releaseInternal('released', { attempts: 1, timeoutMs: 20000 }); }
    catch (error) { await this.stopOnExit(reason, error); throw error; }
  }
  /** A release on exit failed: the record stays, and renewal stops without a final renewal, so the lease ends within its last window. */
  private async stopOnExit(reason: string, error: unknown) {
    this.stopTimer();
    const e = this.enclosure; if (!e) return;
    e.active = false; await this.save().catch(() => {});
    await this.log('exit-release-failed', undefined, { reason, error: String(error), expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at }).catch(() => {});
  }
  async release() {
    await this.restore(); this.assertBinding(); await this.m.assertBackend();
    if (this.enclosure) await this.drained(() => this.releaseDrained());
    return { guest: this.name, active: false as const, released: true as const };
  }
  private async releaseDrained() {
    try {
      await this.log('release');
      if (this.enclosure?.staged && !this.enclosure.delivered) { await this.extractAvailable(); await this.packageInternal(); }
    } catch (error) {
      if (this.enclosure) await jsonFile(`${this.enclosure.hostRoot}.delivery-error.json`, { error: String(error) }).catch(() => {});
    } finally { await this.releaseInternal('released'); }
  }
  private async releaseInternal(reason: 'finished' | 'failed' | 'released', { attempts = 3, timeoutMs = 120000 } = {}) {
    this.assertBinding(); await this.m.assertBackend();
    const e = this.enclosure; if (!e) return;
    await this.findOwner(e);
    this.stopTimer();
    if (!e.released) {
      if (!e.lease) {
        const list = await this.vm.list({ timeoutMs: 10000 });
        const matches = Object.values(list.machines).filter(lease => lease.purpose === e.purpose);
        if (matches.length > 1) throw new Error('Ambiguous acquisition; refusing to remove ownership record');
        if (!matches.length && e.acquisitionInFlight) throw new Error(`Acquire outcome still indeterminate for ${e.purpose}; ownership record retained at ${this.dir}. Reconcile before retrying; never blindly acquire again.`);
        e.lease = matches[0]; await this.save().catch(() => {});
      }
      if (e.lease) {
        let released = false;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const response = await this.vm.release(e.lease.vm, { reason, ...(e.lease.lease_id ? { lease_id: e.lease.lease_id } : {}) }, { timeoutMs });
            if (!response.released) throw new Error('machine-service did not confirm destruction');
            if (e.machine) { e.hygiene = response.hygiene; await this.save().catch(() => {}); }
            released = true; break;
          } catch (error) {
            await this.log('release-error', undefined, { vm: e.lease.vm, cause: reason, attempt: attempt + 1, error: String(error) }).catch(() => {});
            if (e.machine) {
              if (error instanceof MachineServiceError && error.status === 404) await this.findOwner(e, true);
              if (await this.durableReleased(e)) { released = true; break; }
            } else {
              try { await this.vm.get(e.lease.vm, { timeoutMs: 5000 }); }
              catch (getError) { if (getError instanceof MachineServiceError && getError.status === 404) { released = true; break; } }
            }
            if (attempt === attempts - 1) throw error;
          }
        }
        if (!released) throw new Error('Lease release unconfirmed');
        if (e.machine) { if (!await this.durableReleased(e)) throw new Error(`machine-service confirmed the release of ${e.machine}, but the machine still names lease ${e.lease.lease_id}. The release is unverified; ownership retained.`); }
        else if (!await this.destroyed(e.lease.vm)) throw new Error(`machine-service relinquished ${e.lease.vm}, but Tart still lists it. Destruction is unverified; ownership retained. See docs/verification.md dependency limitation.`);
      }
      e.released = true; await this.save().catch(() => {});
    }
    await this.m.registry.remove(e.row);
    await this.session?.close(); this.session = undefined; this.transport = undefined;
    await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, guest: this.name, vm: e.lease?.vm, ...(e.machine ? { machine: e.machine, lease_id: e.lease?.lease_id, hygiene: e.hygiene ?? null } : {}), released: true, reason, failed: e.failed, delivered: e.delivered, finishedAt: new Date().toISOString() }).catch(() => {});
    this.enclosure = undefined; await this.save();
    await this.m.forget(this);
  }
  /** A durable release is verified when the machine no longer names the lease (DC-33). */
  private async durableReleased(e: Enclosure): Promise<boolean> {
    return (await this.leaseRecord(e)).lease_id !== e.lease!.lease_id;
  }
  private async destroyed(vm: string): Promise<boolean> {
    if (this.m.options.verifyDestroyed) return this.m.options.verifyDestroyed(vm);
    // Read-only host observation, not a second guest/transfer channel. The daemon
    // currently drops its lease even when Tart deletion fails; 404 is not proof.
    const environment = this.m.environment;
    const result = await command([this.m.tartPath, 'list', '--format', 'json'], { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024, env: { ...process.env, ...(environment ? environmentVariables(environment) : {}), TART_HOME: this.m.tartHome } });
    if (result.code !== 0) throw new Error(`Cannot verify VM destruction: ${result.stderr}`);
    const entries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.Name !== 'string')) throw new Error('Invalid Tart inventory; destruction not verified');
    return !entries.some(entry => entry.Name === vm);
  }
  async pause(reason: string) {
    this.assertBinding();
    this.stopTimer();
    const e = this.enclosure;
    if (e) {
      await this.finalRenewal(e);
      e.active = false; await this.save(); await this.log('renewal-paused', undefined, { reason, expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at });
    }
  }
  /**
   * H6: renewal renews only a short window, so pausing it renews once for the
   * rest of the lease's own TTL, and the paused VM is retained until that TTL
   * for an explicit finish or release. A failure is recorded, not thrown.
   */
  private async finalRenewal(e: Enclosure) {
    if (!e.lease || e.released) return;
    // An in-flight window renewal lands first, so it cannot shorten this one.
    await this.renewal?.catch(() => {});
    const remaining = this.remainingMs(e);
    if (remaining < MIN_RENEWAL_MS) return;
    try {
      const renewed = await this.vm.heartbeat(e.lease.vm, { ttl_hours: remaining / 3600000, ...(e.lease.lease_id ? { lease_id: e.lease.lease_id } : {}) }, { timeoutMs: 10000 });
      if (this.enclosure === e && !e.released) { e.expiresAt = renewed.ttl_expires_at; e.guestState = renewed.state; }
    } catch (error) {
      await this.log('final-renewal-failed', undefined, { error: String(error), expiresAt: e.expiresAt ?? e.lease.ttl_expires_at }).catch(() => {});
    }
  }
}
