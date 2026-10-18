import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, open, readFile, rename, rm, stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FramedRequest, FramedResponse } from "@wezzard/relay-driver-host-sdk";
import {
  AdmissionEngine, AdmissionRefusedError, CaptureGate, RecordStore, SnapshotStore,
  type ActionParams, type SnapshotCaptureFn,
} from "@wezzard/relay-driver-remote-runtime";
import { afterRequested, safeId, validateImageEvidence, type GuestImageEvidence, type GuestRequest, type GuestSnapshotDescriptor } from "./image-evidence.js";

// The receipt contract is shared with the host image store; re-exported here for the receiver's callers.
export { afterRequested, validateImageEvidence };
export type { GuestImageEvidence, GuestRequest, GuestSnapshotDescriptor };

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_INTERVAL_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

export interface DispatchResult {
  exitStatus: { code: number | null; signal: string | null };
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
  spawnError?: string;
  terminationConfirmed?: boolean;
  terminationDiagnostic?: string;
}
export interface ReceiveOptions {
  root?: string;
  cuaDriver?: string;
  /** Test seam only: production always dispatches an argv with shell:false. */
  dispatch?: (argv: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<DispatchResult>;
  capture?: SnapshotCaptureFn;
}
export type GuestResponse = FramedResponse & {
  /** Absent only on historical receipts from receivers predating this contract. */
  imageEvidence?: GuestImageEvidence;
  evidenceMode?: "diagnostic";
  timeoutMs?: number;
  terminationConfirmed?: boolean;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
};
interface GroupState {
  active?: { groupId: string; sessionId: string; attemptId: string };
  used: string[];
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const bounded = (value = ""): string => {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_OUTPUT_BYTES) return value;
  // Decode only complete UTF-8 characters: replacement of a cut character
  // could otherwise exceed the byte bound by two bytes.
  return new TextDecoder().decode(bytes.subarray(0, MAX_OUTPUT_BYTES), { stream: true });
};

/** Atomic, fsynced sidecars supplement (never replace) the substrate journal. */
async function durableJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function optionalJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function validate(request: GuestRequest): void {
  if (!safeId(request.executionId) || !safeId(request.sessionId) || !safeId(request.attemptId)) throw new Error("safe executionId, sessionId and attemptId are required");
  if (typeof request.because !== "string" || !request.because.trim() || request.because.length > 16_384) throw new Error("nonblank because is required (maximum 16384 characters)");
  if (request.cwd !== undefined && (!text(request.cwd) || !isAbsolute(request.cwd))) throw new Error("cwd must be an absolute path");
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) throw new Error("timeoutMs must be an integer from 1 to 3600000");
  if (request.diagnostic !== undefined && (typeof request.diagnostic !== "boolean" || request.language !== "shell")) throw new Error("diagnostic is allowed only for a shell script and must be boolean");
  if (request.step !== undefined && (!request.step || !safeId(request.step.id) || !text(request.step.title) || (request.step.expected !== undefined && typeof request.step.expected !== "string") || (request.step.inputMode !== undefined && !["ordinary", "accessibility"].includes(request.step.inputMode)))) throw new Error("invalid step metadata");
  const snapshots = request.snapshots;
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) throw new Error("snapshots are required; no implicit interval");
  const interval = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_INTERVAL_MS;
  if (snapshots.afterIntervalMs !== undefined && !interval(snapshots.afterIntervalMs)) throw new Error("invalid afterIntervalMs (0..300000 required)");
  if (snapshots.group !== undefined) {
    const group = snapshots.group;
    if (!group || !safeId(group.groupId) || !["first", "member", "last"].includes(group.phase)) throw new Error("invalid coalescing group");
    if (group.afterIntervalMs !== undefined && !interval(group.afterIntervalMs)) throw new Error("invalid group afterIntervalMs");
    if (group.phase === "last" && !interval(group.afterIntervalMs ?? snapshots.afterIntervalMs)) throw new Error("last group member requires afterIntervalMs");
  } else if (!interval(snapshots.afterIntervalMs)) throw new Error("afterIntervalMs is required; no default");
  if (!["shell", "javascript", "typescript", "python"].includes(request.language ?? "")) throw new Error("language must be shell, javascript, typescript or python");
  // A script is given inline, as its code, or as an uploaded file; the request says which by what it holds (DC-26).
  const inline = request.code !== undefined, file = request.remotePath !== undefined;
  if (inline === file) throw new Error("a request holds either the script's code or its uploaded remotePath");
  if (inline && (typeof request.code !== "string" || !/^[a-f0-9]{64}$/.test(request.codeSha256 ?? ""))) throw new Error("code and its SHA-256 are required");
  if (request.capture !== undefined && typeof request.capture !== "boolean") throw new Error("capture must be boolean");
  if (file && (!text(request.remotePath) || !isAbsolute(request.remotePath) || !/^[a-f0-9]{64}$/.test(request.scriptSha256 ?? ""))) throw new Error("absolute remotePath and script SHA-256 are required");
}

export function groupAbsentFromProcessTable(group: number, table: string): boolean {
  const lines = table.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Empty process table cannot prove group absence');
  const entries = lines.map(line => {
    const match = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line);
    if (!match || Number(match[1]) < 0 || Number(match[2]) < 1) throw new Error('Malformed process table');
    return { group: Number(match[1]), pid: Number(match[2]) };
  });
  // Require our own receiver row to guard against a partial/filtered table.
  if (!entries.some(entry => entry.pid === process.pid)) throw new Error('Process table lacks receiver identity');
  return !entries.some(entry => entry.group === group);
}

async function darwinGroupAbsent(group: number): Promise<boolean | undefined> {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-axo', 'pgid=,pid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      try { resolve(groupAbsentFromProcessTable(group, stdout)); }
      catch { resolve(undefined); }
    });
  });
}

/** A signal is asynchronous: observe termination rather than inspecting once
 * immediately after SIGKILL. Never equate permission errors with absence. */
export async function confirmProcessGroupExit(pid: number, options: { timeoutMs?: number; probe?: (pid: number) => void; pause?: (ms: number) => Promise<void>; clock?: () => number; permissionObserver?: (pid: number) => Promise<boolean | undefined> } = {}): Promise<boolean | undefined> {
  const clock = options.clock ?? (() => performance.now());
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const probe = options.probe ?? (group => { process.kill(-group, 0); });
  const deadline = clock() + (options.timeoutMs ?? 1000);
  for (;;) {
    try { probe(pid); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true;
      const observer = options.permissionObserver ?? (process.platform === 'darwin' ? darwinGroupAbsent : undefined);
      if (code !== 'EPERM' || !observer) return undefined;
      const absent = await observer(pid);
      if (absent !== false) return absent;
    }
    const remaining = deadline - clock();
    if (remaining <= 0) return false;
    await pause(Math.min(25, remaining));
  }
}

/** Killing the process group also stops scripts' children; no shell interpolation. */
async function runArgv(argv: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }, onSpawn?: (pid: number) => Promise<void>): Promise<DispatchResult> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let bytes = 0, timedOut = false, outputTruncated = false, spawnError: string | undefined;
    const stop = (): void => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const available = Math.max(0, MAX_OUTPUT_BYTES - bytes);
      if (available) chunks[stream].push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { outputTruncated = true; stop(); }
    };
    // Failure to persist the process identity must prevent continued execution.
    const identityRetained = child.pid && onSpawn ? onSpawn(child.pid).catch((error) => { spawnError = `process identity retention failed: ${message(error)}`; stop(); }) : Promise.resolve();
    child.stdout.on("data", (c: Buffer) => collect("stdout", c));
    child.stderr.on("data", (c: Buffer) => collect("stderr", c));
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    child.on("error", (error) => { spawnError = message(error); });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await identityRetained;
      // Descendants must not survive completion and issue unrecorded input.
      stop();
      let terminationConfirmed: boolean | undefined, terminationDiagnostic: string | undefined;
      if (child.pid) terminationConfirmed = await confirmProcessGroupExit(child.pid, { probe: pid => {
        try { process.kill(-pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') terminationDiagnostic = `process group ${pid}: ${(error as NodeJS.ErrnoException).code ?? message(error)}`;
          throw error;
        }
      } });
      else if (spawnError) terminationConfirmed = true;
      done({ terminationConfirmed, terminationDiagnostic, exitStatus: { code, signal }, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8"), timedOut, outputTruncated, spawnError });
    });
  });
}

/** Whether `path` is an executable file. */
async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/** Whether an executable named `name` lies on the guest's PATH. */
async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { await access(join(dir, name), constants.X_OK); return true; } catch { /* not in this directory */ }
  }
  return false;
}

/**
 * The argv that runs a script file in its language (DC-25, DC-26): shell
 * with `/bin/sh`, JavaScript with this Node.js, Python with `python3` from PATH, and TypeScript with `tsx`
 * from PATH or else this Node.js's own type stripping (22.6 or later). A
 * missing runtime refuses the run before anything starts.
 */
export async function interpreterArgv(language: string | undefined, path: string, find: (name: string) => Promise<boolean> = onPath, node: { execPath: string; version: string; strips: boolean } = { execPath: process.execPath, version: process.versions.node, strips: Boolean((process.features as { typescript?: unknown }).typescript) }, shell: (path: string) => Promise<boolean> = executable): Promise<string[]> {
  if (language === "shell") {
    if (!(await shell("/bin/sh"))) throw new Error("the guest has no /bin/sh, so a shell script cannot run");
    return ["/bin/sh", path];
  }
  if (language === "python") {
    if (!(await find("python3"))) throw new Error("python3 is not on the guest's PATH, so a Python script cannot run; relay_probe scope=guest reports which runtimes the guest has");
    return ["python3", path];
  }
  if (language !== "typescript") return [node.execPath, path];
  if (await find("tsx")) return ["tsx", path];
  if (node.strips) return [node.execPath, "--disable-warning=ExperimentalWarning", path];
  const [major = 0, minor = 0] = node.version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 6)) return [node.execPath, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", path];
  throw new Error(`the guest has no tsx on its PATH, and its Node.js ${node.version} predates type stripping (22.6), so a TypeScript script cannot run; write it in JavaScript instead`);
}

async function captureWithDriver(outFile: string, driver: string, dispatch: typeof runArgv = runArgv): Promise<void> {
  const result = await dispatch([driver, "call", "get_desktop_state", "--json", JSON.stringify({ screenshot_out_file: outFile })], { env: process.env, timeoutMs: 60_000 });
  if (result.exitStatus.code !== 0 || result.timedOut || result.outputTruncated || result.spawnError || result.terminationConfirmed !== true) throw new Error(`display capture unavailable: ${JSON.stringify({ exitStatus: result.exitStatus, timedOut: result.timedOut, outputTruncated: result.outputTruncated, spawnError: result.spawnError, terminationConfirmed: result.terminationConfirmed, terminationDiagnostic: result.terminationDiagnostic, stdout: result.stdout?.slice(0, 1500), stderr: result.stderr?.slice(0, 1500) })}`);
  const value = JSON.parse(result.stdout ?? "") as { screenshot_file_path?: string };
  if (value.screenshot_file_path !== outFile) throw new Error("display capture returned a missing or mismatched screenshot_file_path");
}

/**
 * One file-framed request per invocation. Lock + write-ahead execution marker
 * prevent concurrent input and replay, including process loss. An abandoned
 * lock is reclaimed only with proof that its owner is dead or settled and
 * its owned process groups are absent. Ambiguous operations fail without replay.
 */
export async function receive(input: unknown, options: ReceiveOptions = {}): Promise<GuestResponse> {
  const request = input as GuestRequest;
  const executionId = request && safeId(request.executionId) ? request.executionId : "unknown";
  const evidenceMode = request?.diagnostic === true ? "diagnostic" as const : undefined;
  // The image lists no capture software: no snapshots are taken or owed.
  const uncaptured = request?.capture === false;
  const timeoutMs = request?.timeoutMs ?? 120_000;
  let imageEvidence: GuestImageEvidence = { status: afterRequested(request) ? "capture-unknown" : "not-requested", snapshots: [] };
  const response = (kind: "refused" | "uncertain", diagnostic: string): GuestResponse => ({ executionId, evidenceMode, timeoutMs, imageEvidence, outcome: { kind, diagnostic: bounded(diagnostic) } });
  let encoded: string;
  try { encoded = JSON.stringify(input); if (!encoded || Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) return response("refused", "request exceeds maximum size or is not JSON"); }
  catch { return response("refused", "request is not serializable JSON"); }
  if (!request || !safeId(request.executionId) || !safeId(request.sessionId) || !safeId(request.attemptId)) return response("refused", "safe executionId, sessionId and attemptId are required");
  const root = resolve(options.root ?? process.env.RELAY_RUNTIME_ROOT ?? "/var/tmp/relay-driver-runtime");
  const state = join(root, "state");
  const lock = join(root, ".receiver-lock");
  const receiptPath = join(state, "receiver", "receipts", `${executionId}.json`);
  const startedPath = join(state, "receiver", "started", `${executionId}.json`);
  const groupPath = join(state, "receiver", "groups.json");
  let store: RecordStore | undefined, ownsLock = false, keepLock = false;
  const ownerPath = join(lock, "owner.json");
  const operationPids: number[] = [];
  let pendingSpawn = false;
  const markLock = (active: boolean, settled = false): Promise<void> => durableJson(ownerPath, { pid: process.pid, executionId, active, operationPids, pendingSpawn, settled });
  const runOwned: typeof runArgv = async (argv, dispatchOptions) => {
    // Cover the crash window between spawn and durable process-ID retention.
    pendingSpawn = true;
    await markLock(true);
    const result = await runArgv(argv, dispatchOptions, async pid => { operationPids.push(pid); pendingSpawn = false; await markLock(true); });
    if (result.terminationConfirmed === true) pendingSpawn = false;
    if (result.terminationConfirmed !== true) keepLock = true;
    if (!keepLock) await markLock(false);
    return result;
  };
  let reconcileGroup: ((diagnostic: string) => Promise<void>) | undefined;
  let dispatchResult: DispatchResult | undefined;
  /** The command the receiver built for the script; unset until the script is verified. */
  let argv: readonly string[] | undefined;
  const output = (): Partial<GuestResponse> => dispatchResult ? { stdout: bounded(dispatchResult.stdout), stderr: bounded(dispatchResult.stderr), timedOut: !!dispatchResult.timedOut, outputTruncated: !!dispatchResult.outputTruncated, terminationConfirmed: dispatchResult.terminationConfirmed } : {};
  try {
    await mkdir(root, { recursive: true });
    // A receipt can be safely inspected even while another execution is live.
    const receipt = await optionalJson<GuestResponse>(receiptPath);
    if (receipt) return receipt;
    if (await optionalJson(startedPath)) return response("uncertain", "execution was already started; it will not be replayed");
    try { await mkdir(lock); ownsLock = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await optionalJson<{ pid: number; active: boolean; operationPids?: number[]; pendingSpawn?: boolean; settled?: boolean }>(ownerPath);
      const absent = (pid: number | undefined, group = false): boolean => {
        if (!Number.isInteger(pid) || !pid || pid < 1) return false;
        try { process.kill(group ? -pid : pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      };
      if (!owner || (!absent(owner.pid) && owner.settled !== true) || (owner.active !== false && !(owner.pendingSpawn === false && Array.isArray(owner.operationPids) && owner.operationPids.length > 0 && owner.operationPids.every(pid => absent(pid, true))))) return response("uncertain", "receiver lock ownership or active operation is unconfirmed; input is not replayed");
      try { await mkdir(join(lock, "recovery")); }
      catch { return response("uncertain", "receiver lock reconciliation is already in progress"); }
      if (JSON.stringify(await optionalJson(ownerPath)) !== JSON.stringify(owner)) return response("uncertain", "receiver lock changed during reconciliation");
      await rename(lock, join(root, `.receiver-lock-retired-${randomUUID()}`));
      try { await mkdir(lock); ownsLock = true; }
      catch { return response("uncertain", "receiver acquired by another operation during reconciliation"); }
    }
    await markLock(false);
    // Recheck after acquiring the shared lock (another invocation may just have finished).
    const recovered = await optionalJson<GuestResponse>(receiptPath);
    if (recovered) return recovered;
    if (await optionalJson(startedPath)) return response("uncertain", "execution was already started; it will not be replayed");
    store = await RecordStore.create(state);
    // Never append onto damaged history, even a routing annotation.
    const history = await store.journalHistory();
    if (history.damagedTail) throw new Error("damaged journal; execution requires recording recovery without modifying prior evidence");
    await durableJson(startedPath, { executionId, requestSha256: hash(encoded) });
    const ids = { sessionId: request.sessionId!, attemptId: request.attemptId! };
    // This fsynced event precedes capture and dispatch, including refusals.
    await store.appendJournal({ kind: "annotation", annotationType: "routing-decision", ...ids, executionId, state: "pending", because: request.because, step: request.step, evidenceMode, timeoutMs, ...(uncaptured ? { capture: false } : {}) }, { durable: true });
    const gate = new CaptureGate();
    let captureFailure: string | undefined;
    const capture: SnapshotCaptureFn = async (out) => {
      try {
        pendingSpawn = true;
        await markLock(true);
        await (options.capture ?? ((file) => captureWithDriver(file, options.cuaDriver ?? process.env.RELAY_CUA_DRIVER ?? (process.platform === "darwin" ? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" : "cua-driver"), runOwned)))(out);
        if (!keepLock) { pendingSpawn = false; await markLock(false); }
        const file = await stat(out);
        if (!file.isFile() || file.size < 1 || file.size > 64 * 1024 * 1024) throw new Error("screenshot file missing, empty or oversized");
      } catch (error) { captureFailure = message(error); gate.reportLoss(captureFailure); throw error; }
    };
    const snapshots = new SnapshotStore(capture, store, state);
    snapshots.setSeq(history.records.length + 1);
    const engine = new AdmissionEngine(store, gate, ids, snapshots);
    const params: ActionParams = { parentExecutionId: executionId, stepId: request.step?.id, title: request.step?.title, inputMode: request.step?.inputMode ?? "ordinary", snapshots: evidenceMode || uncaptured ? undefined : request.snapshots, dispatchIdentity: executionId };
    const actionId = engine.allocateAction(params);
    const retain = async (result: GuestResponse): Promise<GuestResponse> => {
      // The SDK's actionSnapshots can be unset on a partial pair or journal
      // failure. Read original saved-capture records instead; never recapture
      // or modify substrate history to make a response look complete.
      const retained = await store!.journalHistory();
      const descriptors: GuestSnapshotDescriptor[] = [];
      if (!retained.damagedTail) {
        for (const record of retained.records) {
          if (record.kind !== "snapshot-captured" || record.actionId !== actionId) continue;
          const event = record as unknown as { sessionId: string; attemptId: string; group?: string; snapshot: { role: "before" | "after"; capturedAt: string; sha256: string; bytes: number; fileName: string; declaredAfterIntervalMs?: number } };
          if (event.sessionId !== request.sessionId || event.attemptId !== request.attemptId) throw new Error("snapshot identity conflicts with request");
          const s = event.snapshot;
          descriptors.push({ sessionId: event.sessionId, attemptId: event.attemptId, executionId, actionId, stepId: request.step?.id, phase: s.role, capturedAt: s.capturedAt, sha256: s.sha256, bytes: s.bytes, mimeType: "image/png", declaredAfterIntervalMs: s.declaredAfterIntervalMs, fileName: s.fileName, groupId: event.group });
        }
      }
      const candidate: GuestImageEvidence = {
        status: !afterRequested(request) ? "not-requested" : descriptors.some(s => s.phase === "after") ? "available" : captureFailure ? "capture-failed" : "capture-unknown",
        snapshots: descriptors,
      };
      validateImageEvidence(candidate, request);
      imageEvidence = candidate;
      // Match receipt JSON exactly, including omission of unknown fields.
      result = JSON.parse(JSON.stringify({ ...result, imageEvidence, evidenceMode, timeoutMs, ...output() })) as GuestResponse;
      if (result.outcome.kind !== "completed" || result.outcome.exitStatus.code !== 0) await reconcileGroup?.("operation failed or incomplete");
      await store!.putExecution({ executionId, ...ids, state: result.outcome.kind === "completed" ? "recorded" : result.outcome.kind, argv, scriptId: request.scriptId, exitStatus: result.outcome.kind === "completed" ? result.outcome.exitStatus : undefined });
      await store!.appendJournal({ kind: "execution-completion", ...ids, executionId, state: result.outcome.kind === "completed" ? "recorded" : result.outcome.kind, response: result }, { durable: true });
      await durableJson(receiptPath, result);
      return result;
    };
    const refuse = async (diagnostic: string): Promise<GuestResponse> => {
      gate.reportLoss(diagnostic);
      try { await engine.callWithHandle(actionId, params, () => { throw new Error("refused dispatch must never run"); }); }
      catch (error) { if (!(error instanceof AdmissionRefusedError)) throw error; }
      return retain(response("refused", diagnostic));
    };
    try { validate(request); } catch (error) { return await refuse(message(error)); }
    const groups = await optionalJson<GroupState>(groupPath) ?? { used: [] };
    const group = evidenceMode || uncaptured ? undefined : request.snapshots!.group;
    const abandonGroup = async (diagnostic: string): Promise<void> => {
      if (!groups.active) return;
      await store!.appendJournal({ kind: "annotation", annotationType: "group-incomplete", ...ids, executionId, groupId: groups.active.groupId, priorSessionId: groups.active.sessionId, priorAttemptId: groups.active.attemptId, diagnostic, state: "incomplete" }, { durable: true });
      delete groups.active;
      await durableJson(groupPath, groups);
    };
    if (evidenceMode) await abandonGroup("explicit diagnostic interrupted the visual group");
    if (groups.active && (!group || group.groupId !== groups.active.groupId || request.sessionId !== groups.active.sessionId || request.attemptId !== groups.active.attemptId || group.phase === "first")) return await refuse("coalescing group is open; unrelated input is forbidden until its last member");
    if (!groups.active && group && (group.phase !== "first" || groups.used.includes(group.groupId))) return await refuse("coalescing group must begin with a fresh first member; group IDs cannot be reused");
    reconcileGroup = abandonGroup;
    // The receiver builds the command from the language and the verified file, and never runs one the request names,
    // so no interpreter option can run other bytes than the verified script.
    try {
      if (request.remotePath !== undefined) {
        const info = await stat(request.remotePath);
        if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) throw new Error("script missing or exceeds size bound");
        if (hash(await readFile(request.remotePath)) !== request.scriptSha256) throw new Error("script hash mismatch");
        argv = await interpreterArgv(request.language, request.remotePath);
      } else {
        if (hash(request.code!) !== request.codeSha256) throw new Error("streamed code hash mismatch");
        const path = join(root, "streamed", `${executionId}.${{ shell: "sh", python: "py", typescript: "ts", javascript: "js" }[request.language!]}`);
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(request.code!); await file.sync(); } finally { await file.close(); }
        if (hash(await readFile(path)) !== request.codeSha256) throw new Error("materialized streamed code hash mismatch");
        argv = await interpreterArgv(request.language, path);
      }
    } catch (error) { return await refuse(message(error)); }
    const command = argv;
    await store.appendJournal({ kind: "execution-start", ...ids, executionId, state: "admitted", argv, cwd: request.cwd, step: request.step, evidenceMode, timeoutMs, ...(uncaptured ? { capture: false } : {}), scriptIdentity: { sha256: request.remotePath === undefined ? request.codeSha256 : request.scriptSha256, language: request.language, remotePath: argv.at(-1) } }, { durable: true });
    if (group?.phase === "first") {
      groups.active = { groupId: group.groupId, ...ids }; groups.used.push(group.groupId);
      await durableJson(groupPath, groups);
    }
    // Non-first group actions lack a before capture. Reobserve capability with
    // an unretained probe; it is NOT another evidence pair or a group event.
    if (group && group.phase !== "first") {
      const probe = join(root, `.capture-probe-${executionId}.png`);
      try { await capture(probe); } catch (error) { return await refuse(message(error)); }
      finally { await rm(probe, { force: true }); }
    }
    gate.update({ ready: true, observedAtMonotonic: Date.now() });
    let dispatched = false;
    try {
      const outcome = await engine.callWithHandle(actionId, params, async () => {
        dispatched = true;
        pendingSpawn = true;
        await markLock(true);
        try {
          const dispatchOptions = { cwd: request.cwd, env: process.env, timeoutMs };
          dispatchResult = options.dispatch
            ? await options.dispatch(command, dispatchOptions)
            : await runOwned(command, dispatchOptions);
          return dispatchResult;
        } finally {
          if (dispatchResult && dispatchResult.terminationConfirmed !== false && !keepLock) { pendingSpawn = false; await markLock(false); }
          else keepLock = true;
        }
      });
      const expectedCount = !group ? 2 : group.phase === "member" ? 0 : 1;
      if (captureFailure || engine.evidenceFailure || (!evidenceMode && !uncaptured && engine.actionSnapshots?.length !== expectedCount)) {
        const diagnostic = captureFailure ?? engine.evidenceFailure ?? "missing required snapshot evidence";
        return await retain(response("uncertain", diagnostic));
      }
      const result: GuestResponse = outcome.spawnError || outcome.timedOut || outcome.outputTruncated
        ? response("uncertain", outcome.spawnError ?? (outcome.timedOut ? "execution timed out" : "execution exceeded output bound"))
        : { executionId, outcome: { kind: "completed", exitStatus: outcome.exitStatus } };
      if (group?.phase === "last" && result.outcome.kind === "completed" && result.outcome.exitStatus.code === 0) { delete groups.active; await durableJson(groupPath, groups); }
      return await retain({ ...result, stdout: bounded(outcome.stdout), stderr: bounded(outcome.stderr), timedOut: !!outcome.timedOut, outputTruncated: !!outcome.outputTruncated });
    } catch (error) {
      // Failure applies to this execution only; later IDs recheck admission.
      await reconcileGroup?.(message(error));
      await store.appendJournal({ kind: "evidence-failure", ...ids, executionId, actionId, state: dispatched ? "uncertain" : "refused", diagnostic: message(error) }, { durable: true });
      return await retain(response(dispatched ? "uncertain" : error instanceof AdmissionRefusedError ? "refused" : "uncertain", message(error)));
    }
  } catch (error) {
    if (ownsLock) await reconcileGroup?.(message(error)).catch(() => {});
    return { ...response("uncertain", `receiver error: ${message(error)}`), ...output() };
  } finally {
    try { await store?.close(); } catch { keepLock = true; }
    if (ownsLock && !keepLock) await rm(lock, { recursive: true, force: true }).catch(() => {});
    else if (ownsLock) await markLock(true, true).catch(() => {});
  }
}

async function main(): Promise<void> {
  let result: GuestResponse;
  try {
    const path = process.argv[2];
    if (!path) throw new Error("usage: receiver REQUEST.json (file framing; stdin is not used)");
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      if ((await file.stat()).size > MAX_REQUEST_BYTES) throw new Error("request file exceeds maximum size");
      bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
      let length = 0;
      while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
      if (length > MAX_REQUEST_BYTES) throw new Error("request file exceeds maximum size");
      bytes = bytes.subarray(0, length);
    } finally { await file.close(); }
    result = await receive(JSON.parse(bytes.toString("utf8")));
  } catch (error) { result = { executionId: "unknown", imageEvidence: { status: "capture-unknown", snapshots: [] }, outcome: { kind: "refused", diagnostic: bounded(message(error)) } }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) void main();
