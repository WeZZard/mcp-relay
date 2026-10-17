import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, cp, access, writeFile, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GUEST_NETWORKS, guestNetwork, relayStateRoot, type GuestNetwork } from './config.js';
import { fileURLToPath } from 'node:url';
import { Relay, type Session, type SnapshotsRequest, type StepDescription } from '@wezzard/relay-driver-host-sdk';
import { VmService, VmServiceError, type VmLease, type VmBackend } from './vm-service.js';
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
import { searchCatalog, type SearchQuery } from './search.js';
import { recordSearch } from './search-diagnostics.js';
import { acquisitionCapabilities, consoleStatus, type ConsoleStatus } from './console.js';
import { ImageStore, imageCapability, type ImageDescriptor, type ImageTarget, type ImageResult } from './images.js';
import { DownloadQueue, type DownloadJob, type StepResult } from './downloads.js';
import type { LocalSource } from './transfer.js';
import { refreshEvidenceState } from './evidence-merge.js';
import { DEFAULT_AFTER_INTERVAL_MS, TARGET_PACKAGES, cachedTarball, tarballName, targetLaunches, type LaunchContext, type Target, type TargetLaunch, type TargetPackages, type TarballSource } from './targets.js';
import { checkArguments } from './json-schema.js';
import type { CallSummary } from './guest/mcp-host.js';
import type { RelayImageContent } from './surface.js';

export interface Extraction { path: string; name: string }
export interface AcquireInput { task: string; image: string; extractions: Extraction[]; ttlHours?: number; fullWorkspace?: boolean; env?: string; vnc?: boolean }
export interface ConsoleAttemptInput { console_id: string; attempt_id: string }
export interface ConsoleOpenInput extends ConsoleAttemptInput { userRequested: true; reason: string; expected: string }
export interface StageInput { resetRecording?: boolean; workspace?: string; files?: Array<{ local: string; path: string }>; nodePath?: string; cuaDriver?: string; browserExecutable?: string }
/**
 * One run. `because`, `step` and `snapshots` are optional: whatever is left
 * out is derived from the call (see `derive`). `kind: 'mcp'` is relay_run:
 * `target`, `tool` and `args` name one tool call on an in-guest MCP server;
 * `expected` and `afterIntervalMs` are its record overrides.
 */
export interface RunInput { because?: string; timeoutMs?: number; diagnostic?: boolean; kind: 'exec' | 'script' | 'code' | 'mcp'; step?: Partial<StepDescription>; snapshots?: SnapshotsRequest; argv?: string[]; localPath?: string; language?: 'javascript' | 'typescript' | 'python'; code?: string; target?: Target; tool?: string; args?: Record<string, unknown>; expected?: string; afterIntervalMs?: number; hold?: { id: string; timeoutMs?: number } }
interface BackendBinding { endpoint: string; tartHome: string; environmentFingerprint?: string }
interface Enclosure {
  backend?: BackendBinding;
  purpose: string; task: string; image: string; project: string; startedAt: string;
  guestRoot: string; hostRoot: string; ttlHours: number; extractions: Extraction[]; fullWorkspace: boolean;
  lease?: VmLease; row: RegistryRow; staged: boolean; node?: string; cuaDriver?: string; sessionId?: string;
  failed?: string; lastError?: string; released?: boolean; delivered?: DeliveryResult; acquisitionInFlight?: boolean;
  active?: boolean; guestState?: string; expiresAt?: number;
  /** Guest browser for the playwright and chrome-devtools targets; default installed Google Chrome. */
  browserExecutable?: string;
  /** The guest MCP host was started with the current launch configuration. */
  mcpHost?: boolean;
  /** Targets whose pinned packages are unpacked in the guest. */
  mcpPackages?: Target[];
  /** Counter for derived step IDs. */
  runSeq?: number;
  previousEvidence?: Array<{ path: string; sessionId: string; guestState?: string }>;
  pendingReset?: { id: string; from: string; fromSession: string; to: string };
  consoleObservation?: ConsoleStatus;
  consoleAttempt?: { console_id: string; attempt_id: string; status: string };
  consoleAttemptIds?: string[];
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
  /** The guest MCP host bundle; default `dist/mcp-host.mjs`. */
  mcpHostBundle?: string;
  /** Test seams: replace the launch commands, the pinned package closures, the tarball source or the host tarball cache. */
  targetLaunches?: (context: LaunchContext) => Record<string, TargetLaunch>;
  targetPackages?: Partial<Record<Exclude<Target, 'cua'>, TargetPackages>>;
  tarballSource?: TarballSource;
  packageCache?: string;
  /** How far each renewal extends the lease at vm-service; default RENEWAL_WINDOW_MS. */
  renewalWindowMs?: number;
  /** The network every guest is acquired on; default MCP_RELAY_GUEST_NETWORK, read at each acquisition (DC-17). */
  guestNetwork?: GuestNetwork;
  /** Test seam: free space of the evidence volume; default `fs.promises.statfs`. */
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  /** Background downloads a run may leave queued; default DOWNLOAD_BOUND. */
  downloadBound?: number;
  /** Waits between a background download's attempts; default DOWNLOAD_RETRY_DELAYS_MS. */
  downloadRetryDelaysMs?: readonly number[];
}
/**
 * H6: the relay tracks each lease's own deadline (startedAt + ttlHours) and
 * renews vm-service only this far ahead, never past that deadline, so a
 * client that crashes leaves its VM leased for at most this window. A
 * graceful pause renews once for the rest of the TTL (docs/lifecycle-fixes.md).
 */
export const RENEWAL_WINDOW_MS = 15 * 60000;
/** vm-service refuses a ttl_hours below 0.1 h. */
const MIN_RENEWAL_MS = 0.1 * 3600000;
/** The workspace directory and extraction name that carry relay_run results home: each call's full result, the targets' images and files, and the servers' logs. */
export const RELAY_RUN_OUTPUTS = 'relay-run';
/** How long the guest MCP host may take to start a target server, on top of a call's own timeout. */
export const MCP_START_ALLOWANCE_MS = 60000;
/** How long a held relay_run waits for relay_gate when the call names no limit. */
export const DEFAULT_HOLD_MS = 60000;
/**
 * relay_gate's guest side: write the decision whole through a hard link, so
 * the first writer wins, then print the decision that stands. The receiver
 * writes its own `expired` the same way (src/guest/receiver.ts, decideHold).
 */
const DECIDE = `const fs=require('fs'),p=require('path');const [dir,id,want]=process.argv.slice(1);fs.mkdirSync(dir,{recursive:true});const f=p.join(dir,id),t=f+'.'+process.pid+'.'+Date.now()+'.tmp';fs.writeFileSync(t,want,{mode:0o600});try{fs.linkSync(t,f)}catch(e){if(e.code!=='EEXIST')throw e}finally{fs.rmSync(t,{force:true})}console.log(fs.readFileSync(f,'utf8').trim());`;
/** At most this many of a call's own images are delivered inline; the rest stay retrievable with relay_image. */
export const MAX_TOOL_IMAGES = 4;
/** Background step downloads a run may leave queued before it waits for the oldest (DC-4). */
export const DOWNLOAD_BOUND = 64;
/** Waits before a background download's second and third attempts (DC-5). */
export const DOWNLOAD_RETRY_DELAYS_MS = [1000, 3000] as const;
type DisplayTarget = Extract<ImageTarget, { source: 'display' }>;
/** One step download serves both of the step's images (AD-3). */
const downloadKey = (target: Pick<DisplayTarget, 'sessionId' | 'executionId'>) => `${target.sessionId}/${target.executionId}`;
const stepId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
/**
 * The server's MCP `instructions`: the rules that cut across all nineteen
 * tools rather than belonging to one of them (see each tool's own
 * description for its specific contract). A compact version of the same
 * rules also lives in the `relay_probe` and `relay_acquire` descriptions,
 * because not every MCP client surfaces server instructions to the model.
 */
export const instructions = 'This server offers nineteen tools for one interruptive VM enclosure: relay_search, relay_probe, relay_acquisition_capabilities, relay_acquire, relay_stage, relay_run, relay_gate, relay_tools, the command tools relay_exec/relay_script/relay_code, relay_image, relay_extract, relay_finish, relay_release, relay_console_resolve, relay_console_open, relay_console_cancel and relay_status. relay_run sends the cua-driver, Playwright MCP or Chrome DevTools MCP tool calls you already know to that server inside the VM; evidence is automatic, and its after-image is returned as pending and downloaded in the background, so call relay_image with the imageId when you need to see it. Relay only interruptive computer-use or browser-use that would otherwise take over a real desktop or browser, judged for yourself from relay_probe facts; unknown is not idle, and non-disruptive or headless work stays with local tools. One task gets one enclosure: call relay_acquire once per task, never reused for a second task. Work an enclosure in order: relay_probe, then relay_acquire, then relay_stage, then relay_run or the command tools, then relay_image or relay_extract as needed, then relay_finish or relay_release. Always call relay_finish or relay_release explicitly before you return an answer; ending the session only pauses lease renewal, it does not destroy the VM, and the backend\'s own expiry is the last-resort safeguard. A refused, uncertain or nonzero operation keeps the VM so you can diagnose and submit a corrected operation; never replay input whose effect is uncertain. A tool result, an attached image or a verified evidence package, is evidence for a human reviewer, never the review itself. The relay never targets a physical or local display and offers no video or spawn API. Every tool\'s text result is capped at 50 KiB / 2000 lines; a larger result is retained whole in a local file the result names.';

/** relay_release's diagnostic when this session owns no lease. */
export const NO_OWNED_LEASE = 'This session owns no lease, so nothing was released. Each server process has its own session identity (a new random one unless MCP_RELAY_SESSION sets it); a lease acquired under another identity is not visible here. Restart the server with that MCP_RELAY_SESSION to reconcile and release it, or let the backend TTL expire it.';

export class RelayManager {
  readonly vm: VmBackend;
  readonly environment?: SelectedEnvironment;
  readonly tartHome: string;
  readonly tartPath: string;
  readonly registry: Registry;
  readonly root: string;
  readonly channel: VmChannel;
  private enclosure?: Enclosure;
  private session?: Session;
  private transport?: VmTransport;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeating = false;
  private renewal?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private ownerLock?: OwnerLock;
  private shuttingDown = false;
  /** After-image downloads, outside the serialized section (docs/screenshot-delivery.md §10). */
  private readonly downloads: DownloadQueue;
  /** Holds named by relay_run, and the decision each ended with once its receipt is in (docs/relay-run.md, Held input). */
  private readonly holds = new Map<string, { decided?: string }>();
  constructor(readonly options: ManagerOptions) {
    this.environment = options.environment ?? selectedEnvironment();
    this.tartHome = this.environment?.profile.tartHome ?? canonicalPath(options.tartHome ?? process.env.TART_HOME ?? join(process.env.HOME ?? homedir(), '.tart'));
    this.tartPath = this.environment?.profile.tartPath ?? options.tartPath ?? process.env.TART ?? 'tart';
    if (this.environment && ((options.stateRoot && canonicalPath(options.stateRoot) !== this.environment.profile.relayStateDir) || (options.tartHome && canonicalPath(options.tartHome) !== this.tartHome) || (options.tartPath && canonicalPath(options.tartPath) !== this.tartPath))) throw new Error('Injected paths conflict with the selected environment');
    this.vm = options.vm ?? new VmService({ baseUrl: this.environment?.profile.vmServiceUrl ?? process.env.MCP_RELAY_URL, environment: this.environment });
    this.registry = options.registry ?? new Registry(this.environment ? { managedRoot: this.environment.profile.relayStateDir } : {});
    this.root = join(this.environment?.profile.relayStateDir ?? options.stateRoot ?? relayStateRoot(), hash(options.sessionId).slice(0, 32));
    this.channel = {
      exec: async (name, argv, timeoutMs = 180000, options) => {
        const result = await this.vm.exec(name, { argv, timeout: Math.ceil(timeoutMs / 1000) }, { timeoutMs: options?.timeoutMs ?? timeoutMs + 30000, signal: options?.signal });
        return { stdout: result.output, stderr: result.output, code: result.rc };
      },
      push: (name, local_path, remote_path) => this.vm.push(name, { local_path, remote_path }),
      pull: (name, remote_path, local_path, options) => this.vm.pull(name, { remote_path, local_path }, options),
    };
    this.downloads = new DownloadQueue({ bound: options.downloadBound ?? DOWNLOAD_BOUND, record: job => this.recordDownload(job) });
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  async initialize() { return this.serialized(() => this.init()); }
  private async init(hostOnly = false) {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!this.ownerLock) {
      this.ownerLock = await acquireOwnerLock(join(this.root, 'owner.lock')); // Stable inode; never unlink.
      try { this.enclosure = JSON.parse(await readFile(join(this.root, 'lease.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { await this.unlock(); throw e; } }
    }
    try {
      if (this.enclosure) {
        this.enclosure.active = false;
        if (hostOnly) return;
        await this.reconcile();
        if (this.enclosure?.staged && !this.enclosure.delivered) {
          try { await this.attach(); }
          catch (error) { await this.fail(new Error(`Recording session restoration failed; diagnostic repair remains available: ${String(error)}`)); }
        }
      }
      this.initialized = true;
    } catch (error) { await this.unlock(); throw error; }
  }
  private binding(): BackendBinding { return { endpoint: this.vm.baseUrl, tartHome: this.tartHome, ...(this.environment ? { environmentFingerprint: this.environment.identity.fingerprint } : {}) }; }
  private bindingMatches(e: Enclosure): boolean {
    if (e.backend) {
      const expected = this.binding();
      return Object.keys(e.backend).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => e.backend![key as keyof BackendBinding] === value);
    }
    // Only the original default deployment may adopt pre-binding legacy state.
    return !this.environment && new URL(this.vm.baseUrl).origin === 'http://localhost:6240' && this.tartHome === canonicalPath(join(process.env.HOME ?? homedir(), '.tart'));
  }
  private assertBinding() {
    if (this.enclosure && !this.bindingMatches(this.enclosure)) throw new Error('Owned lease belongs to a different or unknown VM environment; select its original environment before operating on it');
  }
  private async assertBackend() {
    if (!this.environment) return;
    if (new URL(this.vm.baseUrl).origin !== new URL(this.environment.profile.vmServiceUrl).origin) throw new Error('Injected backend endpoint does not match selected environment');
    const health = await this.vm.health({ timeoutMs: 5000 });
    if (!health.ok || !matchesEnvironment(health.environment, this.environment)) throw new Error('VM service environment identity mismatch; no lease operation was performed');
  }
  private async save() { await jsonFile(join(this.root, 'lease.json'), this.enclosure ?? null); }
  private async unlock() { if (this.ownerLock) { await this.ownerLock.release(); this.ownerLock = undefined; } }
  status() { const e = this.enclosure; return e ? { task: e.task, backend: e.backend, vm: e.lease?.vm, lease_id: e.lease?.lease_id, console: e.consoleObservation, consoleAttempt: e.consoleAttempt, purpose: e.purpose, staged: e.staged, lastError: e.lastError ?? e.failed, released: e.released, active: e.active ?? false, guestState: e.guestState ?? 'unknown', previousEvidence: e.previousEvidence, recordingResetPending: !!e.pendingReset, expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at, output: e.hostRoot, downloads: this.downloads.counts() } : { active: false }; }
  private async reconcile() {
    const e = this.enclosure; if (!e) return;
    this.assertBinding(); await this.assertBackend();
    e.backend ??= this.binding();
    if (!e.lease) {
      const matches = Object.values((await this.vm.list({ timeoutMs: 10000 })).vms).filter(v => v.purpose === e.purpose);
      if (matches.length !== 1) throw new Error(`Cannot reconcile acquisition for ${e.purpose}; ownership retained, never automatically reacquire`);
      e.lease = matches[0]; e.acquisitionInFlight = false;
    }
    try {
      const lease = await this.vm.get(e.lease.vm, { timeoutMs: 10000 });
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
      if (error instanceof VmServiceError && error.status === 404 && await this.destroyed(e.lease.vm)) {
        await this.registry.remove(e.row);
        await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, vm: e.lease.vm, released: true, reason: 'backend lease absent and destruction verified', finishedAt: new Date().toISOString() });
        this.enclosure = undefined; await this.save(); return;
      }
      await this.save(); throw error;
    }
  }
  private async attach() {
    const e = this.current();
    if (!e.sessionId || !e.node) throw new Error('Persisted staged session lacks runtime identity');
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(this.transfer(), e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver!);
    this.session = await relay.attach(e.sessionId, this.transport);
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
  probe(scope: 'host' | 'guest' = 'host') { return this.serialized(async () => {
    if (scope === 'guest') {
      await this.init();
      return this.guarded(undefined, async () => {
        const e = this.current();
        const checks = [];
        for (const [name, argv] of [['node', [e.node ?? 'node', '--version']], ['cuaDriver', [e.cuaDriver ?? (e.lease!.image_kind === 'macos' ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver'), '--version']]] as const) {
          try { const r = await this.channel.exec(e.lease!.vm, [...argv], 10000); checks.push({ name, ...r, ready: r.code === 0 }); }
          catch (error) { checks.push({ name, ready: false, diagnostic: String(error) }); }
        }
        const targets = await this.targetAvailability(e, checks);
        const facts = { scope, observedAt: new Date().toISOString(), owned: this.status(), checks, targets, captureVerified: false, browserVerified: false };
        await this.log('guest-readiness', undefined, facts); return facts;
      });
    }
    const local = await probeLocal();
    let relay;
    try { const [health, images, leases] = await Promise.all([this.vm.health({ timeoutMs: 5000 }), this.vm.images({ timeoutMs: 5000 }), this.vm.list({ timeoutMs: 5000 })]); relay = { reachable: health.ok, images, capacity: leases.limits }; }
    catch (error) { relay = { reachable: false, diagnostic: String(error) }; }
    const facts = { scope: 'host', local, relay, environment: this.environment?.identity, owned: this.status(), capabilities: { image: imageCapability } };
    await jsonFile(join(this.root, 'probes', `${Date.now()}-${randomUUID()}.json`), facts);
    await this.log('probe', undefined, facts);
    return facts;
  }); }
  private async readAcquisitionCapabilities(signal?: AbortSignal) {
    signal?.throwIfAborted(); await this.assertBackend();
    if (!this.vm.acquisitionCapabilities) throw new Error('Backend lacks acquisition-capabilities; upgrade vm-service for VNC');
    return acquisitionCapabilities(await this.vm.acquisitionCapabilities({ signal, timeoutMs: 10000 }));
  }
  acquisitionCapabilities(signal?: AbortSignal) { return this.serialized(() => this.readAcquisitionCapabilities(signal)); }
  private async consoleOwner(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.shuttingDown) throw new Error('Relay manager is shutting down');
    await this.init(); await this.reconcile();
    const e = this.current();
    if (!e.lease!.lease_id) throw new Error('Legacy lease lacks console identity; no automatic retrofit is available');
    return e;
  }
  private async resolveConsole(signal?: AbortSignal) {
    const e = await this.consoleOwner(signal);
    if (!this.vm.consoleResolve) throw new Error('Backend lacks console API; upgrade vm-service');
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
    const fingerprint = this.environment?.identity.fingerprint ?? e.lease!.console?.environment_fingerprint ?? null;
    if (observation.environment_fingerprint !== fingerprint) throw new Error('Console environment identity mismatch');
  }
  consoleResolve(signal?: AbortSignal) { return this.serialized(() => this.resolveConsole(signal)); }
  consoleOpen(input: ConsoleOpenInput, signal?: AbortSignal) { return this.serialized(async () => {
    this.reason(input.reason); this.reason(input.expected);
    if (input.userRequested !== true) throw new Error('Opening requires an explicit user request');
    return this.consoleOperation('open', input, signal);
  }); }
  consoleCancel(input: ConsoleAttemptInput, signal?: AbortSignal) { return this.serialized(() => this.consoleOperation('cancel', input, signal)); }
  private async consoleOperation(operation: 'open' | 'cancel', input: ConsoleAttemptInput | ConsoleOpenInput, signal?: AbortSignal) {
    if (![input.console_id, input.attempt_id].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(v))) throw new Error('Invalid console or attempt identity');
    const resolved = await this.resolveConsole(signal), e = this.current();
    if (!e.lease!.console?.console_id) throw new Error('This lease has no acquired console; automatic VNC retrofit is forbidden');
    if (resolved.console_id !== input.console_id) throw new Error('Console instance identity mismatch');
    const method = operation === 'open' ? this.vm.consoleOpen : this.vm.consoleCancel;
    if (!method) throw new Error('Backend lacks console API; upgrade vm-service');
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
  /**
   * A host path the relay reads: relative to the project folder, or absolute
   * and already in it; no symlink at or below the folder (DC-15).
   */
  private async projectPath(path: string, label: string) {
    if (typeof path !== 'string' || !path) throw new Error(`${label} must name a host path in the project folder`);
    const project = resolve(this.options.project), target = resolve(project, path);
    try { await assertHostPath(project, target); }
    catch (error) { throw new Error(`${label} ${path} must lie in the project folder ${project}, without symlinks: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    return target;
  }
  private reason(because: string) { if (typeof because !== 'string' || !because.trim() || because.length > 4000) throw new Error('reason must be nonblank and at most 4000 characters'); }
  private current() { this.assertBinding(); if (!this.enclosure?.lease || this.enclosure.released) throw new Error('No active lease; use relay action=acquire'); return this.enclosure; }
  private transfer() { const e = this.current(); if (!e.node) throw new Error('Stage runtime first'); return new Transfer(this.channel, e.lease!.vm, e.node, { guestRoot: e.guestRoot, hostTempRoot: join(this.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event), onArchiveFallback: event => this.log('archive-fallback', undefined, event) }); }
  private async log(kind: string, because?: string, details: unknown = {}) {
    if (because !== undefined) this.reason(because);
    const e = this.enclosure;
    if (e) await jsonFile(e.delivered ? join(`${e.hostRoot}.lifecycle-events`, `${Date.now()}-${randomUUID()}.json`) : join(e.hostRoot, 'host', 'events', `${Date.now()}-${randomUUID()}.json`), { kind, because, at: new Date().toISOString(), details });
  }
  acquire(input: AcquireInput, signal?: AbortSignal) { return this.serialized(async () => {
    await this.init(); signal?.throwIfAborted(); await this.assertBackend();
    if (this.shuttingDown) throw new Error('Relay manager is shutting down');
    if (this.enclosure) throw new Error('This enclosure already owns a lease; finish or release it first');
    // The host names the guest's network; the agent cannot (DC-17).
    const network = this.options.guestNetwork ?? guestNetwork();
    if (!(GUEST_NETWORKS as readonly string[]).includes(network)) throw new Error(`guestNetwork must be nat or internet, not ${JSON.stringify(network)}`);
    if (!/^[a-z0-9][a-z0-9-]{0,35}$/.test(input.task)) throw new Error('task must be a lowercase slug (1–36 chars)');
    if (!Array.isArray(input.extractions) || input.extractions.length > 100) throw new Error('Declare up to 100 extractions before work');
    const names = new Set<string>();
    for (const extraction of input.extractions) {
      within('/workspace', extraction.path);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(extraction.name) || names.has(extraction.name)) throw new Error('Extraction names must be unique safe basenames');
      if (extraction.name === 'full-workspace') throw new Error('full-workspace is a reserved extraction name');
      if (extraction.name === RELAY_RUN_OUTPUTS && extraction.path !== RELAY_RUN_OUTPUTS) throw new Error(`${RELAY_RUN_OUTPUTS} is reserved for relay_run results at workspace/${RELAY_RUN_OUTPUTS}`);
      names.add(extraction.name);
    }
    const ttlHours = input.ttlHours ?? 4;
    if (!Number.isFinite(ttlHours) || ttlHours < 0.1 || ttlHours > 720) throw new Error('ttlHours must be 0.1–720');
    const images = await this.vm.images({ timeoutMs: 5000, signal });
    if (!images.images[input.image]?.base_available) throw new Error(`Image unavailable: ${input.image}`);
    if (input.vnc !== undefined && typeof input.vnc !== 'boolean') throw new Error('vnc must be boolean');
    if (input.vnc) {
      const capabilities = await this.readAcquisitionCapabilities(signal);
      if (!capabilities.options.vnc.backends[images.images[input.image]!.kind].available) throw new Error('VNC backend unavailable for this image OS; ordinary acquisition was not attempted');
    }
    const purpose = `relay-${input.task}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const stamp = startedAt.slice(0, 19).replace(/[T:]/g, '-') + '-Z';
    const hostRoot = join(this.options.outputRoot ?? resolve(this.options.project, 'relay-evidence'), purpose);
    const row: RegistryRow = { machine: this.environment ? `${this.environment.profile.vmServiceUrl} (${this.environment.profile.id}; ${purpose})` : `127.0.0.1 (vm-service ${purpose})`, os: input.image, taskName: purpose, agent: `mcp-relay ${this.options.sessionId}`, project: resolve(this.options.project), startDate: stamp };
    this.enclosure = { backend: this.binding(), purpose, task: input.task, image: input.image, project: this.options.project, startedAt, guestRoot: `/var/tmp/${stamp}-mcp-relay-${purpose}`, hostRoot, ttlHours, extractions: input.extractions, fullWorkspace: input.fullWorkspace ?? false, row, staged: false };
    await this.save();
    try {
      await this.registry.add(row);
      await this.log('acquire-intent', undefined, { ...input, network });
      try { await cp(join(this.root, 'probes'), join(hostRoot, 'host', 'probes'), { recursive: true, errorOnExist: true, force: false }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.enclosure.acquisitionInFlight = true; await this.save();
      try {
        this.enclosure.lease = await this.vm.acquire({ purpose, image: input.image, env: input.env ?? 'none', ttl_hours: Math.min(this.renewalWindowMs(), ttlHours * 3600000) / 3600000, wait: true, network, ...(input.vnc === undefined ? {} : { vnc: input.vnc }) }, { signal });
        this.enclosure.acquisitionInFlight = false;
      } catch (error) {
        if (signal?.aborted && error === signal.reason || error instanceof VmServiceError && error.status !== undefined && error.status >= 400 && error.status < 500) this.enclosure.acquisitionInFlight = false;
        throw error;
      }
      if (this.enclosure.lease?.console) {
        this.enclosure.lease.console = consoleStatus(this.enclosure.lease.console);
        this.enclosure.consoleObservation = this.enclosure.lease.console;
      }
      await this.save(); // keep identity even if registration or cancellation fails
      if (input.vnc && (!this.enclosure.lease?.lease_id || !this.enclosure.lease.console?.console_id || this.enclosure.lease.console.status !== 'ready')) throw new Error('VNC acquisition did not return a ready console and lease identity; ownership retained for reconciliation');
      this.enclosure.guestState = this.enclosure.lease!.state;
      this.enclosure.expiresAt = this.enclosure.lease!.ttl_expires_at;
      this.startHeartbeat(); await this.save();
      // Cancellation is not a release request (technical design 5.2): a lease
      // that arrived after the caller cancelled stays owned and renewed, and
      // the error says so, so the agent can continue, finish or release it.
      if (signal?.aborted) throw new Error(`${String(signal.reason)}; the acquisition completed after it was cancelled: VM ${this.enclosure.lease!.vm} is owned by this session, retained and renewed. Continue with relay_stage, or call relay_finish or relay_release.`, { cause: signal.reason });
      return { ...this.status(), guestRoot: this.enclosure.guestRoot, workspace: join(this.enclosure.guestRoot, 'workspace'), declarations: input.extractions, network };
    } catch (error) { await this.fail(error); throw error; }
  }); }
  private renewalWindowMs() {
    const ms = this.options.renewalWindowMs ?? RENEWAL_WINDOW_MS;
    if (!Number.isFinite(ms) || ms < MIN_RENEWAL_MS) throw new Error('renewalWindowMs must be at least 0.1 hours');
    return ms;
  }
  /** Milliseconds left until the lease's own deadline, startedAt + ttlHours. */
  private remainingMs(e: Enclosure) { return Date.parse(e.startedAt) + e.ttlHours * 3600000 - Date.now(); }
  private startHeartbeat() {
    if (this.timer || !this.enclosure?.lease) return;
    // With less than vm-service's minimum renewal left, the lease already
    // expires at its own deadline; there is nothing left to renew.
    if (this.remainingMs(this.enclosure) < MIN_RENEWAL_MS) { this.enclosure.active = false; return; }
    this.enclosure.active = true;
    const ms = this.options.heartbeatMs ?? Math.min(60000, this.renewalWindowMs() / 3);
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
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.enclosure !== e || e.released) return;
    e.active = false; await this.save();
    await this.log('renewal-stopped', undefined, { reason: 'the lease reached its own TTL', deadline: new Date(Date.parse(e.startedAt) + e.ttlHours * 3600000).toISOString(), expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at });
  }
  private async renew(e: Enclosure, lease: VmLease) {
    try {
      const remaining = this.remainingMs(e);
      if (remaining < MIN_RENEWAL_MS) { await this.stopRenewal(e); return; }
      this.assertBinding(); await this.assertBackend();
      const renewed = await this.vm.heartbeat(lease.vm, { ttl_hours: Math.min(this.renewalWindowMs(), remaining) / 3600000 }, { timeoutMs: 10000 });
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
  private async guarded<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      if (this.shuttingDown) throw new Error('Relay manager is shutting down');
      await this.init(); signal?.throwIfAborted();
      if (this.shuttingDown) throw new Error('Relay manager is shutting down');
      await this.reconcile(); this.current(); this.startHeartbeat();
      const result = await fn(); signal?.throwIfAborted();
      // The operation reached the guest and completed: a paused download worker may go on (AD-4).
      this.downloads.resume();
      return result;
    } catch (error) { await this.fail(error); throw new Error(`${String(error)}\nVM state: ${JSON.stringify(this.status())}`, { cause: error }); }
  }
  stage(input: StageInput, signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    const e = this.current();
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.resetRecording || e.pendingReset) await this.resetRecording();
    if (e.staged && (input.workspace || input.files?.length)) throw new Error('Runtime already staged; use diagnostic exec for repairs or stage with only corrected executable paths');
    // Every host path is checked before anything reaches the guest (DC-15).
    const project = resolve(this.options.project);
    const files = [];
    for (const file of input.files ?? []) files.push({ local: await this.projectPath(file.local, 'files[].local'), path: file.path });
    const workspace = input.workspace === undefined ? undefined : await this.projectPath(input.workspace, 'workspace');
    const bundle = this.options.runtimeBundle ?? fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
    await access(bundle);
    const node = input.nodePath ?? e.node ?? 'node';
    const transfer = new Transfer(this.channel, e.lease!.vm, node, { guestRoot: e.guestRoot, hostTempRoot: join(this.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event), onArchiveFallback: event => this.log('archive-fallback', undefined, event) });
    await transfer.checked([node, '--version']);
    const launchChanged = e.mcpHost && ((input.nodePath !== undefined && input.nodePath !== e.node) || (input.cuaDriver !== undefined && input.cuaDriver !== e.cuaDriver) || (input.browserExecutable !== undefined && input.browserExecutable !== e.browserExecutable));
    e.node = node;
    e.cuaDriver = input.cuaDriver ?? e.cuaDriver ?? (e.lease!.image_kind === 'macos' ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver');
    if (input.browserExecutable !== undefined) e.browserExecutable = input.browserExecutable;
    await this.save();
    // A corrected executable changes how the MCP servers launch: stop the host
    // (and its servers) so the next relay_run starts them with the new paths.
    if (launchChanged) await this.stopMcpHost('corrected executable paths');
    if (e.staged) { await this.session?.close(); await this.attach(); return { staged: true, workspace: join(e.guestRoot, 'workspace'), owned: this.status(), files: [], extractions: e.extractions }; }
    await transfer.checked(['/bin/mkdir', '-p', join(e.guestRoot, 'workspace'), join(e.guestRoot, 'state')]);
    const staged = [await transfer.pushFile(bundle, join(e.guestRoot, 'receiver.mjs'))];
    for (const file of files) staged.push(await transfer.pushFile(file.local, within(join(e.guestRoot, 'support'), file.path), project));
    if (workspace) staged.push(...await transfer.pushTree(workspace, join(e.guestRoot, 'workspace'), project));
    await this.log('stage', undefined, { files: staged, extractions: e.extractions });
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(transfer, e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver);
    relay.useTransport(() => this.transport!);
    this.session = await relay.start({ taskId: e.purpose, target: `vm-service:${e.lease!.vm}` });
    e.sessionId = this.session.sessionId; e.staged = true; await this.save();
    return { staged: true, workspace: join(e.guestRoot, 'workspace'), files: staged, extractions: e.extractions, capabilities: { image: imageCapability } };
  })); }
  run(input: RunInput, signal?: AbortSignal): Promise<RunResult> {
    // A hold is known before the run waits its turn, so relay_gate can decide it while the run is queued or delivered.
    const hold = input.kind === 'mcp' ? input.hold : undefined;
    if (hold) {
      if (this.holds.has(hold.id)) return Promise.reject(new Error(`Hold ${hold.id} was already used; name each hold once`));
      this.holds.set(hold.id, {});
    }
    return this.serialized(() => {
    if (input.because !== undefined) this.reason(input.because);
    return this.guarded<RunResult>(signal, async () => {
    const e = this.current();
    const timeoutMs = input.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeoutMs must be an integer from 1 to 3600000');
    if (input.diagnostic && input.kind !== 'exec') throw new Error('diagnostic is only supported for exec');
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.diagnostic) return this.diagnostic(input, timeoutMs, signal);
    if (e.pendingReset) throw new Error('Recording reset is pending; retry stage to reconcile it, or use diagnostic exec');
    if (!e.staged || !this.session || !this.transport) throw new Error('Use relay_stage before a run, or relay_exec diagnostic=true for setup diagnosis and repair');
    let argv: string[] | undefined, callTimeoutMs = timeoutMs;
    if (input.kind === 'mcp') {
      if (!input.target || !input.tool) throw new Error('relay_run requires target and tool');
      // Checked before anything reaches the guest receiver: a refusal here sends nothing.
      const refusal = await this.prepareMcp(e, input.target, input.tool, input.args ?? {}, signal);
      if (refusal) return { ...refusal, timeoutMs, evidencePath: e.hostRoot, leaseReleased: false, imageDelivery: { status: 'not-requested' as const, diagnostic: 'Nothing was sent, so no snapshot was taken.' } };
      // The dispatch bound covers a first-use server start on top of the call itself.
      callTimeoutMs = Math.min(timeoutMs, 3600000 - MCP_START_ALLOWANCE_MS - 15000);
      argv = [e.node!, join(e.guestRoot, 'mcp-host.mjs'), 'call', join(e.guestRoot, 'mcp'), input.target, input.tool, JSON.stringify(input.args ?? {}), String(callTimeoutMs), String(MCP_START_ALLOWANCE_MS)];
    }
    const record = this.derive(e, input);
    await this.save();
    this.transport.because = record.because;
    this.transport.timeoutMs = input.kind === 'mcp' ? callTimeoutMs + MCP_START_ALLOWANCE_MS + 15000 : timeoutMs;
    this.transport.diagnostic = false;
    this.transport.hold = hold ? { id: hold.id, timeoutMs: hold.timeoutMs ?? DEFAULT_HOLD_MS } : undefined;
    // A cancelled run stops waiting for the receiver's answer; its outcome is then uncertain, never replayed.
    this.transport.signal = signal;
    const options = { step: record.step, snapshots: record.snapshots, cwd: join(e.guestRoot, 'workspace') };
    let result;
    if (input.kind === 'exec' || input.kind === 'mcp') {
      argv ??= input.argv;
      if (!argv?.length) throw new Error('exec requires argv');
      result = await this.session.exec(argv, options);
    } else if (input.kind === 'script') {
      if (!input.localPath || !input.language) throw new Error('script requires localPath and language');
      const local = await this.projectPath(input.localPath, 'localPath');
      result = await this.session.runScript(local, join(e.guestRoot, 'scripts', `${randomUUID()}.${input.language === 'python' ? 'py' : input.language === 'typescript' ? 'ts' : 'js'}`), input.language, options);
    } else if (input.kind === 'code') {
      if (typeof input.code !== 'string' || !input.language) throw new Error('code requires code and language');
      result = await this.session.runCode(input.code, input.language, options);
    } else throw new Error('Unknown operation kind');
    const outcome = result.outcome;
    const held = hold ? this.transport.response?.hold : undefined;
    if (hold && held) this.holds.set(hold.id, { decided: held.decision });
    // A hold that was not released sent nothing: that is the caller's decision, not a failure of the VM.
    if (held && held.decision !== 'go') await this.log('hold-withheld', record.because, { hold: hold!.id, ...held, outcome });
    else if (outcome.kind !== 'completed' || outcome.exitStatus.code !== 0 || outcome.exitStatus.signal) {
      await this.log('execution-failed', record.because, result);
      await this.fail(new Error(`Execution ${result.executionId}: ${JSON.stringify(outcome)}`));
    }
    // The after-image is named, not delivered: the step's evidence downloads in the background (AD-1, AD-2).
    const target: DisplayTarget = { source: 'display', sessionId: e.sessionId!, executionId: result.executionId, phase: 'after' };
    const store = this.imageStore();
    const imageDelivery = await store.pending(target);
    await this.queueDownload(store, target, imageDelivery.status === 'pending', imageDelivery.image);
    const common = { step: record.step, snapshots: record.snapshots, timeoutMs, evidencePath: e.hostRoot, leaseReleased: !this.enclosure, owned: this.status(), imageDelivery };
    if (input.kind === 'mcp') return { ...result, ...await this.mcpResult(e, input.target!, input.tool!, outcome, signal), ...common, ...(held ? { hold: { id: hold!.id, ...held } } : {}) };
    // The guest's bounded output rides along in the receipt the transport filed.
    return { ...result, ...this.transport?.response, ...common };
    });
  }); }
  /**
   * Decides a held relay_run call: `go` lets the guest send it, `cancel`
   * refuses it. Not serialized, since the held run occupies the queue. The
   * first decision written wins, the guest's own `expired` included; the
   * result says which one stands.
   */
  async gate(id: string, decision: 'go' | 'cancel', signal?: AbortSignal) {
    const known = this.holds.get(id);
    if (!known) throw new Error(`No relay_run in this session named hold ${id}`);
    if (known.decided) return { hold: id, requested: decision, decision: known.decided, applied: known.decided === decision };
    const e = this.current();
    if (!e.node) throw new Error('Stage runtime first');
    const result = await this.channel.exec(e.lease!.vm, [e.node, '-e', DECIDE, join(e.guestRoot, 'holds'), id, decision], 30000, { signal });
    const stands = result.code === 0 ? result.stdout.trim().split('\n').at(-1)?.trim() : undefined;
    await this.log('hold-gate', undefined, { hold: id, requested: decision, decision: stands, code: result.code });
    if (!stands) throw new Error(`relay_gate could not write hold ${id} (exit ${result.code}): ${result.stdout.slice(0, 1000)}`);
    return { hold: id, requested: decision, decision: stands, applied: stands === decision };
  }
  /**
   * The step record for a run, from the call itself: a title such as
   * `playwright.browser_click`, an expected result, an input mode, a default
   * after-snapshot wait and a reason. Anything the caller gave overrides it.
   */
  private derive(e: Enclosure, input: RunInput): { because: string; step: StepDescription; snapshots: SnapshotsRequest } {
    const seq = e.runSeq = (e.runSeq ?? 0) + 1;
    const stepId = (prefix: string) => `${prefix.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'run'}-${seq}`;
    if (input.kind === 'mcp') {
      const title = `${input.target}.${input.tool}`.slice(0, 500);
      const args = input.args ?? {};
      // cua-driver forms that act through the accessibility API rather than real pointer or keyboard input.
      const accessibility = input.target === 'cua' && (input.tool === 'set_value' || (e.lease!.image_kind === 'macos' && input.tool === 'type_text') || (['click', 'double_click', 'right_click', 'press_key'].includes(input.tool!) && args.element_index !== undefined));
      return {
        because: input.because ?? `Relay ${title} (no reason given)`,
        step: { id: stepId(title), title, expected: input.expected ?? `${title} returns without a tool error`, inputMode: accessibility ? 'accessibility' : 'ordinary' },
        snapshots: { afterIntervalMs: input.afterIntervalMs ?? DEFAULT_AFTER_INTERVAL_MS[input.target!] },
      };
    }
    const title = input.step?.title ?? (input.kind === 'exec' ? `exec ${(input.argv ?? []).map((arg, index) => index === 0 ? arg.split('/').at(-1) : arg).join(' ')}` : input.kind === 'script' ? `script ${input.localPath?.split('/').at(-1) ?? ''}` : `code (${input.language ?? 'unknown'})`).slice(0, 500);
    const snapshots: SnapshotsRequest = { ...(input.snapshots ?? {}) };
    const group = snapshots.group;
    if (!group ? snapshots.afterIntervalMs === undefined : group.phase === 'last' && group.afterIntervalMs === undefined && snapshots.afterIntervalMs === undefined) Object.assign(snapshots, { afterIntervalMs: DEFAULT_AFTER_INTERVAL_MS.command });
    return {
      because: input.because ?? `Relay ${title} (no reason given)`.slice(0, 4000),
      step: { id: input.step?.id ?? stepId(input.kind), title: title || input.kind, expected: input.step?.expected ?? 'Exits with status 0', inputMode: input.step?.inputMode ?? 'ordinary' },
      snapshots,
    };
  }
  /** Stage what a target needs, start the guest MCP host, and check the call against the target's real tool schema. Returns a refusal when nothing may be sent. */
  private async prepareMcp(e: Enclosure, target: Target, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const transfer = this.transfer();
    await this.ensureMcpHost(e, transfer);
    await this.ensureTargetPackages(e, target, transfer, signal);
    const tools = await this.toolList(e, target, transfer);
    const refuse = async (diagnostic: string, extra: Record<string, unknown>) => {
      await this.log('relay-run-refused', undefined, { target, tool, diagnostic, ...extra });
      return { executionId: null, outcome: { kind: 'refused' as const, diagnostic }, relayOutcome: 'refused', sent: false, target, tool, ...extra, owned: this.status() };
    };
    const definition = tools.find(item => item.name === tool);
    if (!definition) return refuse(`${target} has no tool named ${tool}; nothing was sent. Use relay_tools to see its tools.`, { tools: tools.map(item => item.name) });
    const check = checkArguments(definition.inputSchema, args);
    if (!check.valid) return refuse(`args do not match ${target}.${tool}'s input schema; nothing was sent`, { errors: check.errors, inputSchema: definition.inputSchema });
    if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) return refuse('args exceed 64 KiB; nothing was sent', {});
    return undefined;
  }
  /** Map the guest MCP host's answer to the run result: the target's own text and images pass through, bounded; the full result stays in the workspace. */
  private async mcpResult(e: Enclosure, target: Target, tool: string, outcome: { kind: string; exitStatus?: { code: number | null } }, signal?: AbortSignal) {
    const response = this.transport?.response;
    let summary: CallSummary | undefined;
    try { const parsed = JSON.parse(String(response?.stdout ?? '').trim().split('\n').at(-1) ?? ''); if (parsed?.relayRun === 1) summary = parsed; } catch { /* No readable answer: the outcome says what is known. */ }
    if (summary?.hostUnavailable) { e.mcpHost = false; this.toolLists.clear(); await this.save(); }
    const relayOutcome = outcome.kind !== 'completed' ? outcome.kind : outcome.exitStatus?.code === 0 ? 'completed' : outcome.exitStatus?.code === 3 ? 'completed-with-tool-error' : 'completed-nonzero';
    const passthrough: Array<{ type: 'text'; text: string } | RelayImageContent> = [];
    const toolImages: unknown[] = [];
    const content: unknown[] = [];
    let lines = 0;
    const resultFile = summary?.resultFile ? `workspace/${RELAY_RUN_OUTPUTS}/${summary.resultFile}` : undefined;
    for (const block of summary?.content ?? []) {
      if (typeof block.text === 'string') {
        // The text bound is the relay's own: 50 KiB (the host already cut at 32 KiB characters) and 2000 lines in total.
        const kept = block.text.split('\n').slice(0, Math.max(0, 2000 - lines));
        lines += kept.length;
        const text = kept.join('\n'), cut = block.truncated || text.length < block.text.length;
        passthrough.push({ type: 'text', text: cut ? `${text}\n[Truncated. Full result: ${resultFile}]` : text });
        content.push({ type: block.type, ...(block.uri ? { uri: block.uri } : {}), chars: block.text.length, ...(cut ? { truncated: true } : {}) });
      } else if (block.type === 'image' && block.path) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType ?? '')) toolImages.push({ status: 'presentation-unavailable', path: block.path, mimeType: block.mimeType, diagnostic: 'Only PNG, JPEG and WebP images are delivered inline.' });
        else if (toolImages.length >= MAX_TOOL_IMAGES) toolImages.push({ status: 'not-requested', path: block.path, diagnostic: `Beyond ${MAX_TOOL_IMAGES} inline images; retrieve with relay_image source=application name=${RELAY_RUN_OUTPUTS} path=${block.path}.` });
        else {
          const { content: image, ...delivery } = await this.imageStore().get({ source: 'application', name: RELAY_RUN_OUTPUTS, path: block.path }, signal);
          toolImages.push({ ...delivery, path: block.path });
          if (image) passthrough.push(image as RelayImageContent);
        }
        content.push({ type: 'image', path: block.path, mimeType: block.mimeType, bytes: block.bytes });
      } else content.push(block);
    }
    return {
      relayOutcome, target, tool,
      ...(summary ? { toolOutcome: summary.outcome, sent: summary.sent, ...(summary.diagnostic ? { toolDiagnostic: summary.diagnostic } : {}), ...(summary.errors ? { errors: summary.errors } : {}), content, ...(summary.structuredContent !== undefined ? { structuredContent: summary.structuredContent } : {}), ...(summary.structuredContentOmitted ? { structuredContentOmitted: true } : {}), ...(resultFile ? { resultFile } : {}), toolImages } : { toolOutcome: 'unknown', stdout: response?.stdout, stderr: response?.stderr }),
      ...(response?.stderr ? { stderr: response.stderr } : {}),
      ...(response?.terminationConfirmed !== undefined ? { terminationConfirmed: response.terminationConfirmed } : {}),
      passthrough,
    };
  }
  private toolLists = new Map<string, Array<{ name: string; description?: string; inputSchema: unknown }>>();
  /** A target's real `tools/list`, from the in-guest server, pulled home hash-checked and kept in the host evidence. */
  private async toolList(e: Enclosure, target: Target, transfer: Transfer) {
    const cached = this.toolLists.get(target);
    if (cached) return cached;
    const stateDir = join(e.guestRoot, 'mcp');
    await transfer.checked([e.node!, join(e.guestRoot, 'mcp-host.mjs'), 'tools', stateDir, target], MCP_START_ALLOWANCE_MS * 2 + 20000);
    const bytes = await transfer.pullFrame(join(stateDir, 'tools', `${target}.json`), join(e.hostRoot, 'host', 'mcp-tools', `${target}-${Date.now()}-${randomUUID().slice(0, 8)}.json`), e.guestRoot, e.hostRoot);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed?.target !== target || !Array.isArray(parsed.tools)) throw new Error(`Malformed tool list from ${target}`);
    const tools = (parsed.tools as Array<Record<string, unknown>>).filter(item => typeof item?.name === 'string' && item.inputSchema && typeof item.inputSchema === 'object')
      .map(item => ({ name: item.name as string, ...(typeof item.description === 'string' ? { description: item.description } : {}), inputSchema: item.inputSchema }));
    this.toolLists.set(target, tools);
    return tools;
  }
  /** Push and start the guest MCP host once per launch configuration. It starts each target's server on first use. */
  private async ensureMcpHost(e: Enclosure, transfer: Transfer) {
    if (!e.extractions.some(item => item.name === RELAY_RUN_OUTPUTS)) { e.extractions.push({ path: RELAY_RUN_OUTPUTS, name: RELAY_RUN_OUTPUTS }); await this.save(); }
    if (e.mcpHost) return;
    const bundle = this.options.mcpHostBundle ?? fileURLToPath(new URL('../dist/mcp-host.mjs', import.meta.url));
    const entry = join(e.guestRoot, 'mcp-host.mjs');
    const staged = await transfer.pushFile(bundle, entry);
    const context: LaunchContext = { node: e.node!, cuaDriver: e.cuaDriver!, packagesRoot: join(e.guestRoot, 'mcp', 'packages'), workspace: join(e.guestRoot, 'workspace'), outputDir: join(e.guestRoot, 'workspace', RELAY_RUN_OUTPUTS), ...(e.browserExecutable ? { browserExecutable: e.browserExecutable } : {}) };
    const config = { stateDir: join(e.guestRoot, 'mcp'), outputDir: context.outputDir, targets: (this.options.targetLaunches ?? targetLaunches)(context), startTimeoutMs: MCP_START_ALLOWANCE_MS };
    const local = join(e.hostRoot, 'host', 'mcp-host-config.json');
    await jsonFile(local, config);
    await transfer.pushFile(local, join(e.guestRoot, 'mcp-host-config.json'), e.hostRoot);
    const answer = await transfer.checked([e.node!, entry, 'start', join(e.guestRoot, 'mcp-host-config.json')], 60000);
    e.mcpHost = true; this.toolLists.clear(); await this.save();
    await this.log('mcp-host-start', undefined, { bundle: staged, config, answer: answer.trim().slice(0, 2000) });
  }
  /** Stage a browser target's pinned packages: host-verified tarballs, pushed hash-checked, unpacked in the guest. */
  private async ensureTargetPackages(e: Enclosure, target: Target, transfer: Transfer, signal?: AbortSignal) {
    if (target === 'cua' || e.mcpPackages?.includes(target)) return;
    const closure = this.options.targetPackages?.[target] ?? TARGET_PACKAGES[target];
    const cache = this.options.packageCache ?? join(dirname(this.root), 'mcp-packages');
    const specs: string[] = [], staged: unknown[] = [];
    for (const pin of closure.packages) {
      const local = await cachedTarball(cache, pin, this.options.tarballSource, signal);
      const remote = join(e.guestRoot, 'mcp', 'tarballs', tarballName(pin));
      staged.push({ ...pin, ...await transfer.pushFile(local.path, remote, cache) });
      specs.push(`${pin.name}=${remote}=${local.sha256}`);
    }
    if (specs.length) await transfer.checked([e.node!, join(e.guestRoot, 'mcp-host.mjs'), 'install', join(e.guestRoot, 'mcp', 'packages', 'node_modules'), ...specs], 180000);
    e.mcpPackages = [...(e.mcpPackages ?? []), target]; await this.save();
    await this.log('mcp-target-staged', undefined, { target, packages: staged });
  }
  /** Stop the guest MCP host and its servers. Best effort: destroying the VM remains the final cleanup. */
  private async stopMcpHost(reason: string) {
    const e = this.enclosure;
    if (!e?.mcpHost || !e.node || !e.lease) return;
    try {
      const result = await this.channel.exec(e.lease.vm, [e.node, join(e.guestRoot, 'mcp-host.mjs'), 'stop', join(e.guestRoot, 'mcp')], 30000);
      await this.log('mcp-host-stop', undefined, { reason, code: result.code, output: result.stdout.slice(0, 2000) });
    } catch (error) { await this.log('mcp-host-stop-failed', undefined, { reason, error: String(error) }).catch(() => {}); }
    e.mcpHost = false; this.toolLists.clear(); await this.save();
  }
  /** relay_tools: a target's real tools (names, descriptions, input schemas), optionally one. */
  tools(target: Target, tool?: string, signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    const e = this.current();
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (!e.staged) throw new Error('Use relay_stage before relay_tools');
    const transfer = this.transfer();
    await this.ensureMcpHost(e, transfer);
    await this.ensureTargetPackages(e, target, transfer, signal);
    const tools = await this.toolList(e, target, transfer);
    const selected = tool === undefined ? tools : tools.filter(item => item.name === tool);
    if (tool !== undefined && !selected.length) throw new Error(`${target} has no tool named ${tool}; it has: ${tools.map(item => item.name).join(', ')}`);
    await this.log('tools', undefined, { target, tool, count: selected.length });
    return { target, count: selected.length, tools: selected };
  })); }
  /** Per-target facts for probe scope=guest, without installing or starting anything. */
  private async targetAvailability(e: Enclosure, checks: Array<{ name: string; ready: boolean }>) {
    const node = checks.find(check => check.name === 'node')?.ready ?? false;
    const driver = checks.find(check => check.name === 'cuaDriver')?.ready ?? false;
    const candidates = e.browserExecutable ? [e.browserExecutable] : e.lease!.image_kind === 'macos' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    let browser: { path: string | null; diagnostic?: string } = { path: null };
    if (node) {
      try { const r = await this.channel.exec(e.lease!.vm, [e.node ?? 'node', '-e', 'const fs=require("fs");console.log(JSON.stringify({path:process.argv.slice(1).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return true}catch{return false}})??null}))', ...candidates], 10000); browser = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}'); }
      catch (error) { browser = { path: null, diagnostic: String(error) }; }
    }
    let servers: Record<string, unknown> = {};
    if (e.mcpHost && node) {
      try { const r = await this.channel.exec(e.lease!.vm, [e.node ?? 'node', join(e.guestRoot, 'mcp-host.mjs'), 'status', join(e.guestRoot, 'mcp')], 10000); servers = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}').targets ?? {}; }
      catch (error) { servers = { diagnostic: String(error) }; }
    }
    const browserTarget = (target: Exclude<Target, 'cua'>) => ({
      available: node && !!browser.path, node, browserExecutable: browser.path, browserCandidates: candidates,
      packages: e.mcpPackages?.includes(target) ? 'staged' : 'staged from the host cache on first use', pinned: TARGET_PACKAGES[target].packages.map(pin => `${pin.name}@${pin.version}`),
      server: servers[target] ?? { state: 'not-started' },
    });
    return {
      cua: { available: driver, launch: [e.cuaDriver ?? 'cua-driver', 'mcp'], ...(e.lease!.image_kind === 'macos' ? {} : { requires: 'cua-driver serve --no-overlay running on native X11' }), server: servers.cua ?? { state: 'not-started' } },
      playwright: browserTarget('playwright'),
      'chrome-devtools': browserTarget('chrome-devtools'),
      note: 'Availability means the executables exist; it never proves a browser renders on the display or that capture works.',
    };
  }
  private imageStore() {
    const e = this.current();
    return new ImageStore({ owner: this.options.sessionId, enclosure: e.purpose, backend: e.backend,
      catalogRoot: join(this.root, 'image-catalog', e.purpose), hostRoot: e.hostRoot, guestRoot: e.guestRoot,
      sessionId: e.sessionId, previousEvidence: e.previousEvidence, declarations: e.extractions, transfer: this.transfer(),
      ensureGuest: async (signal, deadline) => {
        const options = { signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) };
        if (this.environment) {
          const health = await this.vm.health(options);
          if (!health.ok || !matchesEnvironment(health.environment, this.environment)) throw Object.assign(new Error('Selected backend identity changed.'), { code: 'unauthorized-reference' });
        }
        try {
          const lease = await this.vm.get(e.lease!.vm, options);
          if (lease.purpose !== e.purpose) throw Object.assign(new Error('Lease ownership identity changed.'), { code: 'unauthorized-reference' });
        } catch (error) {
          if (error instanceof VmServiceError && error.status === 404) throw Object.assign(new Error('Saved image guest is no longer available.'), { code: 'stale-reference' });
          throw error;
        }
      } });
  }
  image(target: ImageTarget, signal?: AbortSignal): Promise<ImageResult> {
    const deadline = Date.now() + 90000;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    return this.serialized(async () => {
    if (bounded.aborted) return { status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded before starting.' };
    await this.init(true); this.assertBinding();
    if (bounded.aborted) return { status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded while loading ownership.' };
    // Verified local image recovery must not depend on a reachable guest. The
    // private catalog still requires this manager's owner lock and enclosure.
    if (!this.enclosure || this.enclosure.released || this.enclosure.delivered) return { status: 'stale-reference', diagnostic: 'Enclosure is closed or sealed; inspect delivered originals with the host read tool.' };
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
  }); }
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
    let resultFile: unknown;
    try { resultFile = JSON.parse(receipt.stdout)?.resultFile; } catch { /* not a relay_run summary */ }
    if (typeof resultFile === 'string') { try { within('/', resultFile); paths.add(`workspace/${RELAY_RUN_OUTPUTS}/${resultFile}`); } catch { /* unsafe: the finish fetches it */ } }
    return [...paths].map(path => ({ path }));
  }
  /**
   * One step download (AD-2, AD-7, AD-8): the step's files in one archive into
   * `host/steps/<executionId>/`, then the after-image filed from there.
   */
  private async downloadStep(store: ImageStore, target: DisplayTarget, requested: ArchiveRequest[], afterImage: boolean, signal: AbortSignal): Promise<StepResult> {
    const e = this.current(), retryDelaysMs = this.options.downloadRetryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
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
  /** AD-9: an extraction takes the files the step downloads already brought, such as `relay-run` results. */
  private async localWorkspace(recording: string): Promise<LocalSource> {
    const steps = await this.stepCopies(recording, 'workspace/');
    return { root: recording, candidates: file => steps.get(`${file.sha256}:${file.bytes}`) ?? [] };
  }
  /** AD-7: the step folders are a staging area; once their files are in the recording's state they go. */
  private async removeStepFolders(recording: string) {
    const steps = join(recording, 'host', 'steps');
    await assertHostPath(recording, steps, true); await rm(steps, { recursive: true, force: true });
  }
  /** A lifecycle operation's gate (AD-5): every download ends before the guest state is touched; the queue opens again after. */
  private async drained<T>(fn: () => Promise<T>): Promise<T> {
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
      const reuse = await this.localWorkspace(e.hostRoot);
      const facts = await transfer.pullVerified(within(join(e.guestRoot, 'workspace'), declaration.path), destination, join(e.guestRoot, 'workspace'), e.hostRoot, { reuse });
      if (reuse.reused) await this.log('extraction-reused', undefined, { name, files: reuse.reused });
      results.push({ ...declaration, destination, facts });
    }
    await jsonFile(join(e.hostRoot, 'host', 'extractions', `${randomUUID()}.json`), { extractions: results });
    return results;
  }
  extract(names: string[], signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    if (this.current().delivered) throw new Error('Evidence already sealed; no further extractions may modify it');
    await this.log('extract', undefined, { names }); return this.extractInternal(names);
  })); }
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
    const info = await (this.options.statfs ?? (path => statfs(path, { bigint: true })))(hostRoot);
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
  finish(signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, () => this.drained(async () => {
    const e = this.current(); await this.log('finish');
    let incomplete: Array<{ name: string; path: string; error: string }> = [];
    if (!e.delivered) {
      // Stop the MCP servers first, so their output files are complete before extraction.
      await this.stopMcpHost('finish');
      incomplete = await this.extractForFinish();
    }
    const result = e.delivered ?? await this.packageInternal();
    await this.releaseInternal('finished');
    return incomplete.length ? { ...result, incompleteExtractions: incomplete } : result;
  }))); }
  private async fail(error: unknown) {
    const e = this.enclosure; if (!e || !this.bindingMatches(e)) return;
    e.lastError = String(error);
    await this.save();
    await this.log('operation-failed', undefined, { error: String(error), leaseRetained: !e.released });
  }
  private async diagnostic(input: RunInput, timeoutMs: number, signal?: AbortSignal) {
    const e = this.current();
    if (!input.argv?.length || input.snapshots?.group) throw new Error('Diagnostic exec requires argv and cannot join a snapshot group');
    const executionId = `diagnostic-${randomUUID()}`;
    const request = { executionId, at: new Date().toISOString(), evidenceMode: 'diagnostic', timeoutMs, ...input };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.request.json`), request);
    let result;
    try {
      const argv = e.staged ? ['/bin/sh', '-c', 'cd "$1" || exit; shift; exec "$@"', 'relay-diagnostic', join(e.guestRoot, 'workspace'), ...input.argv] : input.argv;
      // A cancelled command stops waiting for the guest; the outcome is then uncertain.
      const r = await this.channel.exec(e.lease!.vm, argv, timeoutMs, { signal });
      // vm-service returns one stream with stdout and stderr interleaved; report it once, as what it is.
      result = { executionId, outcome: { kind: 'completed' as const, exitStatus: { code: r.code, signal: null } }, output: r.stdout, outputStreams: 'stdout and stderr combined' };
    } catch (error) { result = { executionId, outcome: { kind: 'uncertain' as const, diagnostic: String(error) }, output: '', outputStreams: 'stdout and stderr combined' }; }
    const response = { ...result, timeoutMs, evidenceMode: 'diagnostic', screenshotEvidence: false, imageDelivery: { status: 'not-requested' as const, diagnostic: 'Diagnostic execution has no screenshot evidence.' }, evidencePath: e.hostRoot, leaseReleased: false, owned: this.status() };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.receipt.json`), response);
    if (result.outcome.kind !== 'completed' || result.outcome.exitStatus.code !== 0) await this.fail(new Error(JSON.stringify(result.outcome)));
    return response;
  }
  release() { return this.serialized(async () => {
    await this.init(); this.assertBinding(); await this.assertBackend();
    // Never guess at another session's lease: say plainly that nothing was released.
    if (!this.enclosure) return { active: false as const, ownedLease: false as const, released: false as const, diagnostic: NO_OWNED_LEASE };
    await this.drained(() => this.releaseDrained());
    return this.status();
  }); }
  private async releaseDrained() {
    try {
      await this.log('release');
      if (this.enclosure?.staged && !this.enclosure.delivered) { await this.stopMcpHost('release'); await this.extractAvailable(); await this.packageInternal(); }
    } catch (error) {
      if (this.enclosure) await jsonFile(`${this.enclosure.hostRoot}.delivery-error.json`, { error: String(error) }).catch(() => {});
    } finally { await this.releaseInternal('released'); }
  }
  private async releaseInternal(reason: 'finished' | 'failed' | 'released') {
    this.assertBinding(); await this.assertBackend();
    const e = this.enclosure; if (!e) return;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (!e.released) {
      if (!e.lease) {
        const list = await this.vm.list({ timeoutMs: 10000 });
        const matches = Object.values(list.vms).filter(lease => lease.purpose === e.purpose);
        if (matches.length > 1) throw new Error('Ambiguous acquisition; refusing to remove ownership record');
        if (!matches.length && e.acquisitionInFlight) throw new Error(`Acquire outcome still indeterminate for ${e.purpose}; ownership record retained at ${this.root}. Reconcile before retrying; never blindly acquire again.`);
        e.lease = matches[0]; await this.save().catch(() => {});
      }
      if (e.lease) {
        let released = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { const response = await this.vm.release(e.lease.vm, { reason }, { timeoutMs: 120000 }); if (!response.released) throw new Error('vm-service did not confirm destruction'); released = true; break; }
          catch (error) {
            await this.log('release-error', undefined, { vm: e.lease.vm, cause: reason, attempt: attempt + 1, error: String(error) }).catch(() => {});
            try { await this.vm.get(e.lease.vm, { timeoutMs: 5000 }); }
            catch (getError) { if (getError instanceof VmServiceError && getError.status === 404) { released = true; break; } }
            if (attempt === 2) throw error;
          }
        }
        if (!released) throw new Error('Lease release unconfirmed');
        if (!await this.destroyed(e.lease.vm)) throw new Error(`vm-service relinquished ${e.lease.vm}, but Tart still lists it. Destruction is unverified; ownership retained. See docs/verification.md dependency limitation.`);
      }
      e.released = true; await this.save().catch(() => {});
    }
    await this.registry.remove(e.row);
    await this.session?.close(); this.session = undefined; this.transport = undefined;
    await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, vm: e.lease?.vm, released: true, reason, failed: e.failed, delivered: e.delivered, finishedAt: new Date().toISOString() }).catch(() => {});
    this.enclosure = undefined; await this.save();
  }
  private async destroyed(vm: string): Promise<boolean> {
    if (this.options.verifyDestroyed) return this.options.verifyDestroyed(vm);
    // Read-only host observation, not a second guest/transfer channel. The daemon
    // currently drops its lease even when Tart deletion fails; 404 is not proof.
    const result = await command([this.tartPath, 'list', '--format', 'json'], { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024, env: { ...process.env, ...(this.environment ? environmentVariables(this.environment) : {}), TART_HOME: this.tartHome } });
    if (result.code !== 0) throw new Error(`Cannot verify VM destruction: ${result.stderr}`);
    const entries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.Name !== 'string')) throw new Error('Invalid Tart inventory; destruction not verified');
    return !entries.some(entry => entry.Name === vm);
  }
  private async pause(reason: string) {
    this.assertBinding();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
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
      const renewed = await this.vm.heartbeat(e.lease.vm, { ttl_hours: remaining / 3600000 }, { timeoutMs: 10000 });
      if (this.enclosure === e && !e.released) { e.expiresAt = renewed.ttl_expires_at; e.guestState = renewed.state; }
    } catch (error) {
      await this.log('final-renewal-failed', undefined, { error: String(error), expiresAt: e.expiresAt ?? e.lease.ttl_expires_at }).catch(() => {});
    }
  }
  async settle() { return this.serialized(() => this.pause('Agent settled; VM retained until explicit release or backend expiration')); }
  /**
   * Shutdown's last resort when an operation does not settle: pause renewal
   * and release the owner lock without waiting for the queue. The process
   * exits right after, so the abandoned operation cannot save again.
   */
  async pauseNow(reason: string) {
    this.shuttingDown = true;
    void this.downloads.close(false);
    try { await this.pause(`${reason}; an in-flight operation did not settle and was abandoned`); }
    finally { this.initialized = false; await this.unlock(); }
  }
  async cleanup(reason: string) { return this.serialized(async () => {
    this.shuttingDown = true;
    try { await this.downloads.close(true); await this.pause(reason); await this.session?.close(); this.session = undefined; this.transport = undefined; }
    finally { this.initialized = false; await this.unlock(); }
  }); }
}
