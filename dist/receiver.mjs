import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/guest/receiver.ts
import { spawn, execFile } from "node:child_process";
import { createHash as createHash2, randomUUID } from "node:crypto";
import { access, constants, mkdir as mkdir3, open, readFile as readFile2, rename as rename3, rm as rm2, stat as stat2, realpath } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, join as join3, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// node_modules/@wezzard/relay-driver-remote-runtime/dist/src/capture-gate.js
function readinessOf(health) {
  return health.ready ?? health.recording ?? false;
}
var DEFAULT_MAX_HEALTH_AGE_MS = 2e3;
var CaptureGate = class {
  maxHealthAgeMs;
  now;
  health;
  constructor(maxHealthAgeMs = DEFAULT_MAX_HEALTH_AGE_MS, now = () => Date.now()) {
    this.maxHealthAgeMs = maxHealthAgeMs;
    this.now = now;
  }
  /** Called by the capture integration (or its failure callback). */
  update(health) {
    this.health = health;
  }
  /** Called when capture capability loss is detected; disables input immediately. */
  reportLoss(diagnostic) {
    this.health = {
      ready: false,
      diagnostic,
      observedAtMonotonic: this.now()
    };
  }
  /**
   * Admission check before each operation. Returns a refusal diagnostic when
   * input must not be dispatched; undefined when screenshot capability is ready.
   */
  checkAdmission() {
    const health = this.health;
    if (!health)
      return "capture health not yet observed";
    const age = this.now() - health.observedAtMonotonic;
    if (age > this.maxHealthAgeMs) {
      return `capture health observation is stale (${age} ms old)`;
    }
    if (!readinessOf(health)) {
      return `capture unavailable: ${health.diagnostic ?? "display screenshot capability not available"}`;
    }
    return void 0;
  }
  get currentSegmentId() {
    return this.health && readinessOf(this.health) ? this.health.segmentId : void 0;
  }
};

// node_modules/@wezzard/relay-driver-remote-runtime/dist/src/record-store.js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// node_modules/@wezzard/relay-driver-core/dist/src/identity.js
var SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
function allocateSuffix(now = Date.now(), random = Math.random) {
  const time = now.toString(36).padStart(9, "0");
  let rand = "";
  for (let i = 0; i < 8; i++) {
    rand += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)];
  }
  return `${time}${rand}`;
}
function allocateId(kind, now = Date.now(), random = Math.random) {
  return { kind, suffix: allocateSuffix(now, random) };
}
function formatId(id) {
  return `${id.kind}-${id.suffix}`;
}

// node_modules/@wezzard/relay-driver-core/dist/src/journal.js
import { promises as fs } from "node:fs";
var JournalWriter = class _JournalWriter {
  path;
  seq = 0;
  handle;
  constructor(path) {
    this.path = path;
  }
  static async create(path) {
    const writer = new _JournalWriter(path);
    writer.handle = await fs.open(path, "a");
    const handle = writer.handle;
    handle.unref?.();
    return writer;
  }
  /**
   * Append one record. `durable` fsyncs before returning (start records).
   * The whole line is written or the call rejects; a rejected append may
   * leave a partial line, which readers report as a damaged tail.
   */
  async append(record, options = {}) {
    if (!this.handle)
      throw new Error("journal writer is closed");
    const full = {
      ...record,
      seq: this.seq++,
      writtenAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const line = Buffer.from(JSON.stringify(full) + "\n", "utf8");
    let offset = 0;
    while (offset < line.length) {
      const { bytesWritten } = await this.handle.write(line, offset, line.length - offset, null);
      if (!(bytesWritten > 0)) {
        throw new Error(`journal write made no progress after ${offset} of ${line.length} bytes (seq ${full.seq})`);
      }
      offset += bytesWritten;
    }
    if (options.durable) {
      await this.handle.sync();
    }
    return full;
  }
  async close() {
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = void 0;
    }
  }
};
async function readJournal(path, options = {}) {
  let text2;
  try {
    text2 = await fs.readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { records: [] };
    }
    throw err;
  }
  const records = [];
  let damagedTail;
  const lines = text2.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "")
      continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1) {
        damagedTail = line;
      } else {
        damagedTail = damagedTail === void 0 ? line : damagedTail;
      }
    }
    if (options.limit && records.length >= options.limit)
      break;
  }
  return { records, damagedTail };
}

// node_modules/@wezzard/relay-driver-remote-runtime/dist/src/record-store.js
var RecordStore = class _RecordStore {
  rootDir;
  journal;
  constructor(rootDir) {
    this.rootDir = rootDir;
  }
  static async create(rootDir) {
    await mkdir(join(rootDir, "records"), { recursive: true });
    await mkdir(join(rootDir, "journal"), { recursive: true });
    const store = new _RecordStore(rootDir);
    store.journal = await JournalWriter.create(join(rootDir, "journal", "events.jsonl"));
    return store;
  }
  recordPath(kind, id) {
    return join(this.rootDir, "records", kind, `${id}.json`);
  }
  async writeRecord(kind, id, record) {
    const path = this.recordPath(kind, id);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await rename(tmp, path);
  }
  async readRecord(kind, id) {
    try {
      return JSON.parse(await readFile(this.recordPath(kind, id), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT")
        return void 0;
      throw err;
    }
  }
  async appendJournal(record, options = {}) {
    if (!this.journal)
      throw new Error("store is closed");
    return this.journal.append(record, options);
  }
  // ---- sessions / attempts / executions ----
  async putSession(session) {
    await this.writeRecord("session", session.sessionId, session);
  }
  async getSession(sessionId) {
    return this.readRecord("session", sessionId);
  }
  async putAttempt(attempt) {
    await this.writeRecord("attempt", attempt.attemptId, attempt);
  }
  async getAttempt(attemptId) {
    return this.readRecord("attempt", attemptId);
  }
  async putExecution(execution) {
    await this.writeRecord("execution", execution.executionId, execution);
  }
  async getExecution(executionId) {
    return this.readRecord("execution", executionId);
  }
  async putAction(action) {
    await this.writeRecord("action", action.actionId, action);
  }
  async getAction(actionId) {
    return this.readRecord("action", actionId);
  }
  /**
   * Durable start retention: the journal fsyncs the start record before the
   * callable may be invoked. Returns after the record is on disk.
   */
  async retainActionStart(params) {
    const record = await this.getAction(params.actionId);
    if (!record)
      throw new Error(`unknown action ${params.actionId}`);
    if (record.state !== "pending") {
      throw new Error(`action ${params.actionId} is not pending (state: ${record.state})`);
    }
    const start = await this.appendJournal({
      kind: "action-start",
      sessionId: params.sessionId,
      attemptId: params.attemptId,
      stepId: params.stepId,
      executionId: params.executionId,
      actionId: params.actionId,
      state: "admitted",
      title: params.title,
      inputMode: params.inputMode,
      snapshotPlan: params.snapshots?.plan
    }, { durable: true });
    const updated = {
      ...record,
      state: "admitted",
      startRetainedAt: start.writtenAt
    };
    await this.putAction(updated);
  }
  /**
   * Retain the snapshot evidence references for one action (SNAP-02/03):
   * hashes-at-capture, file names, provenance, and for coalescing groups
   * the pair-citation layout. Journal record fsynced — snapshot references
   * are durable evidence, not prose.
   */
  async retainActionSnapshots(actionId, snapshots, plan) {
    const record = await this.getAction(actionId);
    if (!record)
      throw new Error(`unknown action ${actionId}`);
    await this.appendJournal({
      kind: "snapshot-evidence",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      actionId,
      state: "recorded",
      snapshots,
      snapshotRole: plan.role,
      groupId: plan.group?.groupId
    });
    await this.putAction({
      ...record,
      snapshots,
      snapshotRole: plan.role,
      groupId: plan.group?.groupId
    });
  }
  async retainActionCompletion(params) {
    const record = await this.getAction(params.actionId);
    if (!record)
      throw new Error(`unknown action ${params.actionId}`);
    if (record.state !== "admitted") {
      throw new Error(`action ${params.actionId} is not admitted (state: ${record.state})`);
    }
    await this.appendJournal({
      kind: "action-completion",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      executionId: record.executionId,
      actionId: record.actionId,
      state: "recorded",
      toolOutcome: params.toolOutcome
    });
    await this.putAction({
      ...record,
      state: "recorded",
      toolOutcome: params.toolOutcome,
      evidenceStatus: "retained"
    });
  }
  /**
   * Close an admitted action whose callable never ran (for example, the
   * before-snapshot could not be captured after the durable start). The
   * `action-refusal` record states that no input was dispatched; it is not a
   * tool completion and carries no tool outcome (D26).
   */
  async retainActionRefusal(params) {
    const record = await this.getAction(params.actionId);
    if (!record)
      throw new Error(`unknown action ${params.actionId}`);
    if (record.state !== "admitted") {
      throw new Error(`action ${params.actionId} is not admitted (state: ${record.state})`);
    }
    await this.appendJournal({
      kind: "action-refusal",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      stepId: record.stepId,
      executionId: record.executionId,
      actionId: record.actionId,
      state: "refused",
      inputDispatched: false,
      diagnostic: params.diagnostic
    }, { durable: true });
    await this.putAction({
      ...record,
      state: "refused",
      evidenceStatus: "not-applicable"
    });
  }
  /**
   * Mark an admitted action uncertain (process/transport lost before
   * completion). Never resolves the outcome; recovery may later find the
   * original record.
   */
  async markUncertain(actionId, diagnostic) {
    const record = await this.getAction(actionId);
    if (!record)
      throw new Error(`unknown action ${actionId}`);
    if (record.state !== "admitted")
      return;
    await this.appendJournal({
      kind: "action-completion",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      actionId: record.actionId,
      state: "uncertain",
      diagnostic
    });
    await this.putAction({
      ...record,
      state: "uncertain",
      evidenceStatus: "unconfirmed"
    });
  }
  async journalHistory() {
    return readJournal(join(this.rootDir, "journal", "events.jsonl"));
  }
  async close() {
    await this.journal?.close();
  }
};

// node_modules/@wezzard/relay-driver-remote-runtime/dist/src/snapshots.js
import { mkdir as mkdir2, stat, rename as rename2, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join as join2 } from "node:path";
function isoStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\./g, ".").replace(/-$/, "Z");
}
var SnapshotCaptureError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "SnapshotCaptureError";
  }
};
var SnapshotStore = class {
  capture;
  store;
  rootDir;
  seq = 0;
  constructor(capture, store, rootDir) {
    this.capture = capture;
    this.store = store;
    this.rootDir = rootDir;
  }
  get snapshotsDir() {
    return join2(this.rootDir, "snapshots");
  }
  fileNameFor(identity, role, capturedAt) {
    const seqPart = `a${String(identity.journalSeq).padStart(6, "0")}`;
    const safeIdentity = identity.dispatchIdentity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
    return `${seqPart}-${isoStamp(capturedAt)}-${role}-${safeIdentity}.png`;
  }
  /** Capture one snapshot with provenance; hashes the file at capture. */
  async captureOne(identity, role, declared = {}) {
    const dir = join2(this.snapshotsDir, identity.sessionId);
    await mkdir2(dir, { recursive: true });
    const captureStartedAtMonotonic = Date.now();
    const capturedAt = new Date(captureStartedAtMonotonic);
    const fileName = this.fileNameFor(identity, role, capturedAt);
    const tmpPath = join2(dir, `.${fileName}.part`);
    const finalPath = join2(dir, fileName);
    try {
      await this.capture(tmpPath);
      await rename2(tmpPath, finalPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {
      });
      throw new SnapshotCaptureError(`screenshot capture failed for ${role}-snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
    const statInfo = await stat(finalPath);
    const sha256 = await hashFile(finalPath);
    const captureCompletedAtMonotonic = Date.now();
    return {
      fileName,
      sha256,
      bytes: statInfo.size,
      captureStartedAtMonotonic,
      captureCompletedAtMonotonic,
      capturedAt: capturedAt.toISOString(),
      role,
      declaredAfterIntervalMs: declared.afterIntervalMs,
      actualWaitMs: declared.waitStartMonotonic !== void 0 ? captureStartedAtMonotonic - declared.waitStartMonotonic : void 0
    };
  }
  /** Capture the before-snapshot for an event (journal seq must be pre-allocated). */
  async before(identity) {
    return this.captureOne(identity, "before");
  }
  /**
   * Wait exactly `afterIntervalMs` from `dispatchCompletedAtMonotonic`, then
   * capture the after-snapshot. The wait is exact per contract: no polling,
   * no stability detection.
   */
  async after(identity, dispatchCompletedAtMonotonic, afterIntervalMs) {
    const target = dispatchCompletedAtMonotonic + afterIntervalMs;
    const waitStartMonotonic = dispatchCompletedAtMonotonic;
    await waitUntil(target);
    return this.captureOne(identity, "after", { afterIntervalMs, waitStartMonotonic });
  }
  nextSeq() {
    return ++this.seq;
  }
  setSeq(value) {
    this.seq = Math.max(this.seq, value);
  }
  async close() {
  }
};
function waitUntil(targetMonotonic) {
  return new Promise((resolve2) => {
    const tick = () => {
      const remaining = targetMonotonic - Date.now();
      if (remaining <= 0)
        resolve2();
      else
        setTimeout(tick, Math.min(remaining, 250));
    };
    tick();
  });
}
async function hashFile(path) {
  const { readFile: readFile3 } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile3(path)).digest("hex");
}

// node_modules/@wezzard/relay-driver-remote-runtime/dist/src/admission.js
var AdmissionRefusedError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "AdmissionRefusedError";
  }
};
var HandleAlreadyUsedError = class extends Error {
  actionId;
  constructor(actionId) {
    super(`action handle ${actionId} was already invoked; use a new handle for a deliberate retry`);
    this.actionId = actionId;
    this.name = "HandleAlreadyUsedError";
  }
};
var EvidenceWriteError = class extends Error {
  actionId;
  toolOutcome;
  constructor(actionId, toolOutcome, cause) {
    super(`evidence retention failed for action ${actionId}; input is disabled`, { cause });
    this.actionId = actionId;
    this.toolOutcome = toolOutcome;
    this.name = "EvidenceWriteError";
  }
};
var AdmissionEngine = class {
  store;
  capture;
  ids;
  snapshotStore;
  /** Set when any evidence write fails; input stays disabled for the session. */
  evidenceFailed = false;
  evidenceFailureDiagnostic;
  lastSnapshots;
  constructor(store, capture, ids, snapshotStore) {
    this.store = store;
    this.capture = capture;
    this.ids = ids;
    this.snapshotStore = snapshotStore;
  }
  /** Why input is currently disabled, or undefined when admission is possible. */
  refusalReason() {
    if (this.evidenceFailed) {
      return `evidence retention previously failed: ${this.evidenceFailureDiagnostic}`;
    }
    return this.capture.checkAdmission();
  }
  get evidenceFailure() {
    return this.evidenceFailureDiagnostic;
  }
  /** Snapshot evidence captured during the most recent call(). */
  get actionSnapshots() {
    return this.lastSnapshots;
  }
  allocateAction(params) {
    const id = allocateId("action");
    const actionId = formatId(id);
    return actionId;
  }
  /**
   * The full call sequence for one backend invocation. The callable runs in
   * the caller's process; admission and retention happen here.
   */
  async call(params, callable) {
    const actionId = this.allocateAction(params);
    return this.callWithHandle(actionId, params, callable);
  }
  /**
   * Resolve the snapshot plan for the params, or undefined when the action
   * carries no snapshot evidence. Throws AdmissionRefusedError on contract
   * violations — a missing required interval is a usage refusal BEFORE any
   * dispatch (never an uncertain run).
   */
  resolveSnapshotPlan(params, actionId) {
    const p = params.snapshots;
    if (!p)
      return void 0;
    if (!this.snapshotStore) {
      throw new AdmissionRefusedError("snapshots requested but this engine has no snapshot store configured");
    }
    const identity = this.dispatchIdentityOf(actionId, params);
    if (p.group) {
      const groupId = p.group.groupId;
      if (!groupId) {
        throw new AdmissionRefusedError("coalescing group declared without groupId");
      }
      switch (p.group.phase) {
        case "first":
          return { capturesBefore: true, capturesAfter: false, role: "first", group: { groupId } };
        case "member":
          return { capturesBefore: false, capturesAfter: false, role: "member", group: { groupId } };
        case "last": {
          const interval = p.group.afterIntervalMs ?? p.afterIntervalMs;
          if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) {
            throw new AdmissionRefusedError(`coalescing group ${groupId}: after-snapshot interval is required on the last member (agent-supplied per the snapshot contract)`);
          }
          return {
            capturesBefore: false,
            capturesAfter: { afterIntervalMs: interval },
            role: "last",
            group: { groupId }
          };
        }
        default:
          throw new AdmissionRefusedError(`coalescing group phase must be first|member|last, got: ${String(p.group.phase)}`);
      }
      void identity;
    }
    if (typeof p.afterIntervalMs !== "number" || !Number.isFinite(p.afterIntervalMs) || p.afterIntervalMs < 0) {
      throw new AdmissionRefusedError("after-snapshot interval is required: supply afterIntervalMs (agent-supplied per the snapshot contract; the runtime never guesses)");
    }
    return {
      capturesBefore: true,
      capturesAfter: { afterIntervalMs: p.afterIntervalMs },
      role: "single"
    };
  }
  dispatchIdentityOf(actionId, params) {
    if (params.dispatchIdentity)
      return params.dispatchIdentity;
    if (params.title)
      return params.title;
    if (params.stepId)
      return params.stepId;
    return actionId;
  }
  /** Call sequence for an existing handle identity. */
  async callWithHandle(actionId, params, callable) {
    if (this.evidenceFailed) {
      throw new AdmissionRefusedError(this.refusalReason());
    }
    const existing = await this.store.getAction(actionId);
    if (existing && existing.state !== "pending") {
      throw new HandleAlreadyUsedError(actionId);
    }
    const refusal = this.capture.checkAdmission();
    if (refusal) {
      await this.store.putAction({
        actionId,
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        stepId: params.stepId,
        state: "refused",
        title: params.title,
        inputMode: params.inputMode,
        executionId: params.parentExecutionId,
        evidenceStatus: "not-applicable"
      });
      await this.store.appendJournal({
        kind: "action-refusal",
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        actionId,
        state: "refused",
        diagnostic: refusal
      });
      throw new AdmissionRefusedError(refusal);
    }
    let snapPlan;
    try {
      snapPlan = this.resolveSnapshotPlan(params, actionId);
    } catch (err) {
      if (err instanceof AdmissionRefusedError) {
        await this.store.putAction({
          actionId,
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          stepId: params.stepId,
          state: "refused",
          title: params.title,
          inputMode: params.inputMode,
          executionId: params.parentExecutionId,
          evidenceStatus: "not-applicable"
        });
        await this.store.appendJournal({
          kind: "action-refusal",
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          actionId,
          state: "refused",
          diagnostic: err.message
        });
      }
      throw err;
    }
    this.lastSnapshots = void 0;
    await this.store.putAction({
      actionId,
      sessionId: this.ids.sessionId,
      attemptId: this.ids.attemptId,
      stepId: params.stepId,
      state: "pending",
      title: params.title,
      inputMode: params.inputMode,
      executionId: params.parentExecutionId
    });
    let toolOutcome;
    try {
      await this.store.retainActionStart({
        actionId,
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        stepId: params.stepId,
        title: params.title,
        inputMode: params.inputMode,
        executionId: params.parentExecutionId,
        snapshots: snapPlan ? { plan: snapPlan } : void 0
      });
      const snapshots = [];
      if (snapPlan?.capturesBefore && this.snapshotStore) {
        const identity = {
          journalSeq: this.snapshotStore.nextSeq(),
          dispatchIdentity: this.dispatchIdentityOf(actionId, params),
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId
        };
        let before;
        try {
          before = await this.snapshotStore.before(identity);
        } catch (err) {
          if (err instanceof SnapshotCaptureError) {
            throw new AdmissionRefusedError(err.message);
          }
          throw err;
        }
        snapshots.push(before);
        await this.store.appendJournal({
          kind: "snapshot-captured",
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          actionId,
          state: "recorded",
          snapshot: before,
          group: snapPlan.group?.groupId
        });
      }
      let value;
      try {
        value = await callable();
        toolOutcome = { kind: "success", value };
      } catch (err) {
        toolOutcome = { kind: "failure", error: err };
        value = void 0;
      }
      const dispatchCompletedAtMonotonic = Date.now();
      if (snapPlan?.capturesAfter && this.snapshotStore) {
        const identity = {
          journalSeq: this.snapshotStore.nextSeq(),
          dispatchIdentity: this.dispatchIdentityOf(actionId, params),
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId
        };
        try {
          const after = await this.snapshotStore.after(identity, dispatchCompletedAtMonotonic, snapPlan.capturesAfter.afterIntervalMs);
          snapshots.push(after);
          await this.store.appendJournal({
            kind: "snapshot-captured",
            sessionId: this.ids.sessionId,
            attemptId: this.ids.attemptId,
            actionId,
            state: "recorded",
            snapshot: after,
            group: snapPlan.group?.groupId
          });
        } catch (err) {
          if (err instanceof SnapshotCaptureError) {
            const diag = err instanceof Error ? err.message : String(err);
            await this.store.appendJournal({
              kind: "capture-status",
              sessionId: this.ids.sessionId,
              attemptId: this.ids.attemptId,
              actionId,
              state: "incomplete",
              diagnostic: diag
            }).catch(() => {
            });
          } else {
            throw err;
          }
        }
      }
      if (snapPlan) {
        this.lastSnapshots = snapshots;
        await this.store.retainActionSnapshots(actionId, snapshots, snapPlan);
      }
    } catch (err) {
      if (err instanceof AdmissionRefusedError) {
        await this.retainRefusalAfterStart(actionId, err);
        throw err;
      }
      if (err instanceof EvidenceWriteError) {
        throw err;
      }
      toolOutcome = { kind: "failure", error: err };
    }
    try {
      await this.store.retainActionCompletion({
        actionId,
        toolOutcome: serializeOutcome(toolOutcome)
      });
    } catch (err) {
      this.evidenceFailed = true;
      this.evidenceFailureDiagnostic = String(err);
      await this.store.appendJournal({
        kind: "evidence-failure",
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        actionId,
        state: "incomplete",
        diagnostic: String(err)
      }).catch(() => {
      });
      throw new EvidenceWriteError(actionId, toolOutcome, err);
    }
    if (toolOutcome.kind === "failure") {
      throw toolOutcome.error;
    }
    return toolOutcome.value;
  }
  /**
   * Retain the refusal of an action whose start was already retained. A
   * failure to retain it is an evidence failure: input is disabled (D17).
   */
  async retainRefusalAfterStart(actionId, refusal) {
    try {
      await this.store.retainActionRefusal({ actionId, diagnostic: refusal.message });
    } catch (err) {
      this.evidenceFailed = true;
      this.evidenceFailureDiagnostic = String(err);
      await this.store.appendJournal({
        kind: "evidence-failure",
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        actionId,
        state: "incomplete",
        diagnostic: String(err)
      }).catch(() => {
      });
      throw new EvidenceWriteError(actionId, { kind: "refused", diagnostic: refusal.message }, err);
    }
  }
};
function serializeOutcome(outcome) {
  if (outcome && typeof outcome === "object" && "kind" in outcome) {
    const o = outcome;
    if (o.kind === "success")
      return { kind: "success", value: describe(o.value) };
    if (o.kind === "failure")
      return { kind: "failure", error: describe(o.error) };
  }
  return describe(outcome);
}
function describe(value) {
  if (value instanceof Error) {
    return { errorName: value.name, message: value.message };
  }
  return value;
}

// src/guest/image-evidence.ts
var safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
function afterRequested(request) {
  return !(request?.kind === "exec" && request.diagnostic === true) && request?.capture !== false && !["first", "member"].includes(request?.snapshots?.group?.phase ?? "");
}
function validateImageEvidence(value, request, authoritativeSnapshots) {
  const fail = () => {
    throw new Error("invalid image evidence");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const evidence = value;
  if (!["available", "not-requested", "capture-failed", "capture-unknown"].includes(evidence.status) || !Array.isArray(evidence.snapshots) || evidence.snapshots.length > 2) fail();
  const group = request.snapshots?.group;
  const phases = /* @__PURE__ */ new Set();
  let actionId;
  for (const s of evidence.snapshots) {
    if (!s || typeof s !== "object" || Array.isArray(s) || s.sessionId !== request.sessionId || s.attemptId !== request.attemptId || s.executionId !== request.executionId || !safeId(s.actionId) || s.stepId !== request.step?.id || s.groupId !== group?.groupId || !["before", "after"].includes(s.phase) || phases.has(s.phase) || actionId !== void 0 && actionId !== s.actionId || typeof s.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.capturedAt) || !Number.isFinite(Date.parse(s.capturedAt)) || typeof s.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.bytes > 64 * 1024 * 1024 || s.mimeType !== "image/png" || typeof s.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/.test(s.fileName) || s.fileName.length > 255 || request.diagnostic === true || request.capture === false || s.phase === "before" && group && group.phase !== "first" || s.phase === "after" && !afterRequested(request) || s.declaredAfterIntervalMs !== (s.phase === "after" ? group?.afterIntervalMs ?? request.snapshots?.afterIntervalMs : void 0)) fail();
    phases.add(s.phase);
    actionId = s.actionId;
  }
  if (evidence.status === "not-requested" !== !afterRequested(request) || evidence.status === "available" !== phases.has("after")) fail();
  if (authoritativeSnapshots !== void 0) {
    if (authoritativeSnapshots.length !== evidence.snapshots.length) fail();
    const fields = ["sessionId", "attemptId", "executionId", "actionId", "stepId", "phase", "capturedAt", "sha256", "bytes", "mimeType", "declaredAfterIntervalMs", "fileName", "groupId"];
    for (const s of evidence.snapshots) {
      const original = authoritativeSnapshots.find((record) => record.phase === s.phase);
      if (!original || fields.some((field) => original[field] !== s[field])) fail();
    }
  }
}

// src/guest/receiver.ts
var MAX_REQUEST_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 64 * 1024;
var MAX_INTERVAL_MS = 3e5;
var MAX_TIMEOUT_MS = 36e5;
var MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
var message = (error) => error instanceof Error ? error.message : String(error);
var hash = (bytes) => createHash2("sha256").update(bytes).digest("hex");
var text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");
var bounded = (value = "") => {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_OUTPUT_BYTES) return value;
  return new TextDecoder().decode(bytes.subarray(0, MAX_OUTPUT_BYTES), { stream: true });
};
async function durableJson(path, data) {
  await mkdir3(dirname2(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 384);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename3(temporary, path);
  const directory = await open(dirname2(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function optionalJson(path) {
  try {
    return JSON.parse(await readFile2(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function validate(request) {
  if (!safeId(request.executionId) || !safeId(request.sessionId) || !safeId(request.attemptId)) throw new Error("safe executionId, sessionId and attemptId are required");
  if (typeof request.because !== "string" || !request.because.trim() || request.because.length > 16384) throw new Error("nonblank because is required (maximum 16384 characters)");
  if (!["exec", "script", "code"].includes(request.kind)) throw new Error("kind must be exec, script or code");
  if (request.cwd !== void 0 && (!text(request.cwd) || !isAbsolute(request.cwd))) throw new Error("cwd must be an absolute path");
  if (request.timeoutMs !== void 0 && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) throw new Error("timeoutMs must be an integer from 1 to 3600000");
  if (request.diagnostic !== void 0 && (typeof request.diagnostic !== "boolean" || request.kind !== "exec")) throw new Error("diagnostic is allowed only for exec and must be boolean");
  if (request.step !== void 0 && (!request.step || !safeId(request.step.id) || !text(request.step.title) || request.step.expected !== void 0 && typeof request.step.expected !== "string" || request.step.inputMode !== void 0 && !["ordinary", "accessibility"].includes(request.step.inputMode))) throw new Error("invalid step metadata");
  const snapshots = request.snapshots;
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) throw new Error("snapshots are required; no implicit interval");
  const interval = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_INTERVAL_MS;
  if (snapshots.afterIntervalMs !== void 0 && !interval(snapshots.afterIntervalMs)) throw new Error("invalid afterIntervalMs (0..300000 required)");
  if (snapshots.group !== void 0) {
    const group = snapshots.group;
    if (!group || !safeId(group.groupId) || !["first", "member", "last"].includes(group.phase)) throw new Error("invalid coalescing group");
    if (group.afterIntervalMs !== void 0 && !interval(group.afterIntervalMs)) throw new Error("invalid group afterIntervalMs");
    if (group.phase === "last" && !interval(group.afterIntervalMs ?? snapshots.afterIntervalMs)) throw new Error("last group member requires afterIntervalMs");
  } else if (!interval(snapshots.afterIntervalMs)) throw new Error("afterIntervalMs is required; no default");
  if (request.kind !== "code" && (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > 256 || !request.argv.every((arg, index) => typeof arg === "string" && !arg.includes("\0") && (index > 0 || arg.length > 0)))) throw new Error("argv must be a nonempty string vector without NULs (maximum 256 entries)");
  if (request.kind !== "exec" && !["javascript", "typescript", "python"].includes(request.language ?? "")) throw new Error("script/code language is required");
  if (request.kind === "code" && (typeof request.code !== "string" || !/^[a-f0-9]{64}$/.test(request.codeSha256 ?? ""))) throw new Error("code and its SHA-256 are required");
  if (request.capture !== void 0 && typeof request.capture !== "boolean") throw new Error("capture must be boolean");
  if (request.kind === "script" && (!text(request.remotePath) || !isAbsolute(request.remotePath) || !/^[a-f0-9]{64}$/.test(request.scriptSha256 ?? ""))) throw new Error("absolute remotePath and script SHA-256 are required");
}
function groupAbsentFromProcessTable(group, table) {
  const lines = table.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Empty process table cannot prove group absence");
  const entries = lines.map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line);
    if (!match || Number(match[1]) < 0 || Number(match[2]) < 1) throw new Error("Malformed process table");
    return { group: Number(match[1]), pid: Number(match[2]) };
  });
  if (!entries.some((entry) => entry.pid === process.pid)) throw new Error("Process table lacks receiver identity");
  return !entries.some((entry) => entry.group === group);
}
async function darwinGroupAbsent(group) {
  return new Promise((resolve2) => {
    execFile("/bin/ps", ["-axo", "pgid=,pid=,stat="], { encoding: "utf8", timeout: 1e3, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve2(void 0);
        return;
      }
      try {
        resolve2(groupAbsentFromProcessTable(group, stdout));
      } catch {
        resolve2(void 0);
      }
    });
  });
}
async function confirmProcessGroupExit(pid, options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const pause = options.pause ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  const probe = options.probe ?? ((group) => {
    process.kill(-group, 0);
  });
  const deadline = clock() + (options.timeoutMs ?? 1e3);
  for (; ; ) {
    try {
      probe(pid);
    } catch (error) {
      const code = error.code;
      if (code === "ESRCH") return true;
      const observer = options.permissionObserver ?? (process.platform === "darwin" ? darwinGroupAbsent : void 0);
      if (code !== "EPERM" || !observer) return void 0;
      const absent = await observer(pid);
      if (absent !== false) return absent;
    }
    const remaining = deadline - clock();
    if (remaining <= 0) return false;
    await pause(Math.min(25, remaining));
  }
}
async function runArgv(argv, options, onSpawn) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0, timedOut = false, outputTruncated = false, spawnError;
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const collect = (stream, chunk) => {
      const available = Math.max(0, MAX_OUTPUT_BYTES - bytes);
      if (available) chunks[stream].push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        outputTruncated = true;
        stop();
      }
    };
    const identityRetained = child.pid && onSpawn ? onSpawn(child.pid).catch((error) => {
      spawnError = `process identity retention failed: ${message(error)}`;
      stop();
    }) : Promise.resolve();
    child.stdout.on("data", (c) => collect("stdout", c));
    child.stderr.on("data", (c) => collect("stderr", c));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    child.on("error", (error) => {
      spawnError = message(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await identityRetained;
      stop();
      let terminationConfirmed, terminationDiagnostic;
      if (child.pid) terminationConfirmed = await confirmProcessGroupExit(child.pid, { probe: (pid) => {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if (error.code !== "ESRCH") terminationDiagnostic = `process group ${pid}: ${error.code ?? message(error)}`;
          throw error;
        }
      } });
      else if (spawnError) terminationConfirmed = true;
      done({ terminationConfirmed, terminationDiagnostic, exitStatus: { code, signal }, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8"), timedOut, outputTruncated, spawnError });
    });
  });
}
async function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      await access(join3(dir, name), constants.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
async function interpreterArgv(language, path, find = onPath, node = { execPath: process.execPath, version: process.versions.node, strips: Boolean(process.features.typescript) }) {
  if (language === "python") {
    if (!await find("python3")) throw new Error("python3 is not on the guest's PATH, so a Python script cannot run; relay_probe scope=guest reports which runtimes the guest has");
    return ["python3", path];
  }
  if (language !== "typescript") return [node.execPath, path];
  if (await find("tsx")) return ["tsx", path];
  if (node.strips) return [node.execPath, "--disable-warning=ExperimentalWarning", path];
  const [major = 0, minor = 0] = node.version.split(".").map(Number);
  if (major > 22 || major === 22 && minor >= 6) return [node.execPath, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", path];
  throw new Error(`the guest has no tsx on its PATH, and its Node.js ${node.version} predates type stripping (22.6), so a TypeScript script cannot run; write it in JavaScript instead`);
}
async function captureWithDriver(outFile, driver, dispatch = runArgv) {
  const result = await dispatch([driver, "call", "get_desktop_state", "--json", JSON.stringify({ screenshot_out_file: outFile })], { env: process.env, timeoutMs: 6e4 });
  if (result.exitStatus.code !== 0 || result.timedOut || result.outputTruncated || result.spawnError || result.terminationConfirmed !== true) throw new Error(`display capture unavailable: ${JSON.stringify({ exitStatus: result.exitStatus, timedOut: result.timedOut, outputTruncated: result.outputTruncated, spawnError: result.spawnError, terminationConfirmed: result.terminationConfirmed, terminationDiagnostic: result.terminationDiagnostic, stdout: result.stdout?.slice(0, 1500), stderr: result.stderr?.slice(0, 1500) })}`);
  const value = JSON.parse(result.stdout ?? "");
  if (value.screenshot_file_path !== outFile) throw new Error("display capture returned a missing or mismatched screenshot_file_path");
}
async function receive(input, options = {}) {
  const request = input;
  const executionId = request && safeId(request.executionId) ? request.executionId : "unknown";
  const evidenceMode = request?.kind === "exec" && request.diagnostic === true ? "diagnostic" : void 0;
  const uncaptured = request?.capture === false;
  const timeoutMs = request?.timeoutMs ?? 12e4;
  let imageEvidence = { status: afterRequested(request) ? "capture-unknown" : "not-requested", snapshots: [] };
  const response = (kind, diagnostic) => ({ executionId, evidenceMode, timeoutMs, imageEvidence, outcome: { kind, diagnostic: bounded(diagnostic) } });
  let encoded;
  try {
    encoded = JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) return response("refused", "request exceeds maximum size or is not JSON");
  } catch {
    return response("refused", "request is not serializable JSON");
  }
  if (!request || !safeId(request.executionId) || !safeId(request.sessionId) || !safeId(request.attemptId)) return response("refused", "safe executionId, sessionId and attemptId are required");
  const root = resolve(options.root ?? process.env.RELAY_RUNTIME_ROOT ?? "/var/tmp/relay-driver-runtime");
  const state = join3(root, "state");
  const lock = join3(root, ".receiver-lock");
  const receiptPath = join3(state, "receiver", "receipts", `${executionId}.json`);
  const startedPath = join3(state, "receiver", "started", `${executionId}.json`);
  const groupPath = join3(state, "receiver", "groups.json");
  let store, ownsLock = false, keepLock = false;
  const ownerPath = join3(lock, "owner.json");
  const operationPids = [];
  let pendingSpawn = false;
  const markLock = (active, settled = false) => durableJson(ownerPath, { pid: process.pid, executionId, active, operationPids, pendingSpawn, settled });
  const runOwned = async (argv, dispatchOptions) => {
    pendingSpawn = true;
    await markLock(true);
    const result = await runArgv(argv, dispatchOptions, async (pid) => {
      operationPids.push(pid);
      pendingSpawn = false;
      await markLock(true);
    });
    if (result.terminationConfirmed === true) pendingSpawn = false;
    if (result.terminationConfirmed !== true) keepLock = true;
    if (!keepLock) await markLock(false);
    return result;
  };
  let reconcileGroup;
  let dispatchResult;
  const output = () => dispatchResult ? { stdout: bounded(dispatchResult.stdout), stderr: bounded(dispatchResult.stderr), timedOut: !!dispatchResult.timedOut, outputTruncated: !!dispatchResult.outputTruncated, terminationConfirmed: dispatchResult.terminationConfirmed } : {};
  try {
    await mkdir3(root, { recursive: true });
    const receipt = await optionalJson(receiptPath);
    if (receipt) return receipt;
    if (await optionalJson(startedPath)) return response("uncertain", "execution was already started; it will not be replayed");
    try {
      await mkdir3(lock);
      ownsLock = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await optionalJson(ownerPath);
      const absent = (pid, group2 = false) => {
        if (!Number.isInteger(pid) || !pid || pid < 1) return false;
        try {
          process.kill(group2 ? -pid : pid, 0);
          return false;
        } catch (error2) {
          return error2.code === "ESRCH";
        }
      };
      if (!owner || !absent(owner.pid) && owner.settled !== true || owner.active !== false && !(owner.pendingSpawn === false && Array.isArray(owner.operationPids) && owner.operationPids.length > 0 && owner.operationPids.every((pid) => absent(pid, true)))) return response("uncertain", "receiver lock ownership or active operation is unconfirmed; input is not replayed");
      try {
        await mkdir3(join3(lock, "recovery"));
      } catch {
        return response("uncertain", "receiver lock reconciliation is already in progress");
      }
      if (JSON.stringify(await optionalJson(ownerPath)) !== JSON.stringify(owner)) return response("uncertain", "receiver lock changed during reconciliation");
      await rename3(lock, join3(root, `.receiver-lock-retired-${randomUUID()}`));
      try {
        await mkdir3(lock);
        ownsLock = true;
      } catch {
        return response("uncertain", "receiver acquired by another operation during reconciliation");
      }
    }
    await markLock(false);
    const recovered = await optionalJson(receiptPath);
    if (recovered) return recovered;
    if (await optionalJson(startedPath)) return response("uncertain", "execution was already started; it will not be replayed");
    store = await RecordStore.create(state);
    const history = await store.journalHistory();
    if (history.damagedTail) throw new Error("damaged journal; execution requires recording recovery without modifying prior evidence");
    await durableJson(startedPath, { executionId, requestSha256: hash(encoded) });
    const ids = { sessionId: request.sessionId, attemptId: request.attemptId };
    await store.appendJournal({ kind: "annotation", annotationType: "routing-decision", ...ids, executionId, state: "pending", because: request.because, step: request.step, evidenceMode, timeoutMs, ...uncaptured ? { capture: false } : {} }, { durable: true });
    const gate = new CaptureGate();
    let captureFailure;
    const capture = async (out) => {
      try {
        pendingSpawn = true;
        await markLock(true);
        await (options.capture ?? ((file2) => captureWithDriver(file2, options.cuaDriver ?? process.env.RELAY_CUA_DRIVER ?? (process.platform === "darwin" ? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" : "cua-driver"), runOwned)))(out);
        if (!keepLock) {
          pendingSpawn = false;
          await markLock(false);
        }
        const file = await stat2(out);
        if (!file.isFile() || file.size < 1 || file.size > 64 * 1024 * 1024) throw new Error("screenshot file missing, empty or oversized");
      } catch (error) {
        captureFailure = message(error);
        gate.reportLoss(captureFailure);
        throw error;
      }
    };
    const snapshots = new SnapshotStore(capture, store, state);
    snapshots.setSeq(history.records.length + 1);
    const engine = new AdmissionEngine(store, gate, ids, snapshots);
    const params = { parentExecutionId: executionId, stepId: request.step?.id, title: request.step?.title, inputMode: request.step?.inputMode ?? "ordinary", snapshots: evidenceMode || uncaptured ? void 0 : request.snapshots, dispatchIdentity: executionId };
    const actionId = engine.allocateAction(params);
    const retain = async (result) => {
      const retained = await store.journalHistory();
      const descriptors = [];
      if (!retained.damagedTail) {
        for (const record of retained.records) {
          if (record.kind !== "snapshot-captured" || record.actionId !== actionId) continue;
          const event = record;
          if (event.sessionId !== request.sessionId || event.attemptId !== request.attemptId) throw new Error("snapshot identity conflicts with request");
          const s = event.snapshot;
          descriptors.push({ sessionId: event.sessionId, attemptId: event.attemptId, executionId, actionId, stepId: request.step?.id, phase: s.role, capturedAt: s.capturedAt, sha256: s.sha256, bytes: s.bytes, mimeType: "image/png", declaredAfterIntervalMs: s.declaredAfterIntervalMs, fileName: s.fileName, groupId: event.group });
        }
      }
      const candidate = {
        status: !afterRequested(request) ? "not-requested" : descriptors.some((s) => s.phase === "after") ? "available" : captureFailure ? "capture-failed" : "capture-unknown",
        snapshots: descriptors
      };
      validateImageEvidence(candidate, request);
      imageEvidence = candidate;
      result = JSON.parse(JSON.stringify({ ...result, imageEvidence, evidenceMode, timeoutMs, ...output() }));
      if (result.outcome.kind !== "completed" || result.outcome.exitStatus.code !== 0) await reconcileGroup?.("operation failed or incomplete");
      await store.putExecution({ executionId, ...ids, state: result.outcome.kind === "completed" ? "recorded" : result.outcome.kind, argv: request.argv, scriptId: request.scriptId, exitStatus: result.outcome.kind === "completed" ? result.outcome.exitStatus : void 0 });
      await store.appendJournal({ kind: "execution-completion", ...ids, executionId, state: result.outcome.kind === "completed" ? "recorded" : result.outcome.kind, response: result }, { durable: true });
      await durableJson(receiptPath, result);
      return result;
    };
    const refuse = async (diagnostic) => {
      gate.reportLoss(diagnostic);
      try {
        await engine.callWithHandle(actionId, params, () => {
          throw new Error("refused dispatch must never run");
        });
      } catch (error) {
        if (!(error instanceof AdmissionRefusedError)) throw error;
      }
      return retain(response("refused", diagnostic));
    };
    try {
      validate(request);
    } catch (error) {
      return await refuse(message(error));
    }
    const groups = await optionalJson(groupPath) ?? { used: [] };
    const group = evidenceMode || uncaptured ? void 0 : request.snapshots.group;
    const abandonGroup = async (diagnostic) => {
      if (!groups.active) return;
      await store.appendJournal({ kind: "annotation", annotationType: "group-incomplete", ...ids, executionId, groupId: groups.active.groupId, priorSessionId: groups.active.sessionId, priorAttemptId: groups.active.attemptId, diagnostic, state: "incomplete" }, { durable: true });
      delete groups.active;
      await durableJson(groupPath, groups);
    };
    if (evidenceMode) await abandonGroup("explicit diagnostic interrupted the visual group");
    if (groups.active && (!group || group.groupId !== groups.active.groupId || request.sessionId !== groups.active.sessionId || request.attemptId !== groups.active.attemptId || group.phase === "first")) return await refuse("coalescing group is open; unrelated input is forbidden until its last member");
    if (!groups.active && group && (group.phase !== "first" || groups.used.includes(group.groupId))) return await refuse("coalescing group must begin with a fresh first member; group IDs cannot be reused");
    reconcileGroup = abandonGroup;
    let argv = request.argv ?? [];
    try {
      if (request.kind === "script") {
        const info = await stat2(request.remotePath);
        if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) throw new Error("script missing or exceeds size bound");
        if (hash(await readFile2(request.remotePath)) !== request.scriptSha256) throw new Error("script hash mismatch");
        const expected = request.language === "python" ? "python3" : request.language === "typescript" ? "tsx" : "node";
        if (argv.length !== 2 || argv[0].split("/").at(-1) !== expected || argv[1] !== request.remotePath) throw new Error("script argv must be [interpreter, verified remotePath]");
        argv = await interpreterArgv(request.language, request.remotePath);
      } else if (request.kind === "code") {
        if (hash(request.code) !== request.codeSha256) throw new Error("streamed code hash mismatch");
        const extension = request.language === "python" ? "py" : request.language === "typescript" ? "ts" : "js";
        const path = join3(root, "streamed", `${executionId}.${extension}`);
        await mkdir3(dirname2(path), { recursive: true });
        const file = await open(path, "wx", 384);
        try {
          await file.writeFile(request.code);
          await file.sync();
        } finally {
          await file.close();
        }
        if (hash(await readFile2(path)) !== request.codeSha256) throw new Error("materialized streamed code hash mismatch");
        argv = await interpreterArgv(request.language, path);
      }
    } catch (error) {
      return await refuse(message(error));
    }
    await store.appendJournal({ kind: "execution-start", ...ids, executionId, state: "admitted", argv, cwd: request.cwd, step: request.step, evidenceMode, timeoutMs, ...uncaptured ? { capture: false } : {}, scriptIdentity: request.kind === "exec" ? void 0 : { sha256: request.kind === "code" ? request.codeSha256 : request.scriptSha256, language: request.language, remotePath: argv.at(-1) } }, { durable: true });
    if (group?.phase === "first") {
      groups.active = { groupId: group.groupId, ...ids };
      groups.used.push(group.groupId);
      await durableJson(groupPath, groups);
    }
    if (group && group.phase !== "first") {
      const probe = join3(root, `.capture-probe-${executionId}.png`);
      try {
        await capture(probe);
      } catch (error) {
        return await refuse(message(error));
      } finally {
        await rm2(probe, { force: true });
      }
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
          dispatchResult = options.dispatch ? await options.dispatch(argv, dispatchOptions) : await runOwned(argv, dispatchOptions);
          return dispatchResult;
        } finally {
          if (dispatchResult && dispatchResult.terminationConfirmed !== false && !keepLock) {
            pendingSpawn = false;
            await markLock(false);
          } else keepLock = true;
        }
      });
      const expectedCount = !group ? 2 : group.phase === "member" ? 0 : 1;
      if (captureFailure || engine.evidenceFailure || !evidenceMode && !uncaptured && engine.actionSnapshots?.length !== expectedCount) {
        const diagnostic = captureFailure ?? engine.evidenceFailure ?? "missing required snapshot evidence";
        return await retain(response("uncertain", diagnostic));
      }
      const driver = options.cuaDriver ?? process.env.RELAY_CUA_DRIVER;
      if (request.kind === "exec" && driver && argv[0] === driver && argv[1] === "call" && outcome.exitStatus.code === 0) {
        let value;
        try {
          value = JSON.parse(outcome.stdout ?? "");
        } catch {
        }
        if (value && typeof value === "object" && (value.isError === true || value.error || typeof value.code === "string" && value.code.length > 0)) {
          const diagnostic = `CUA structured failure: ${JSON.stringify(value)}`;
          return await retain({ ...response(value.code === "desktop_escalation_required" ? "refused" : "uncertain", diagnostic), stdout: bounded(outcome.stdout), stderr: bounded(outcome.stderr) });
        }
      }
      const result = outcome.spawnError || outcome.timedOut || outcome.outputTruncated ? response("uncertain", outcome.spawnError ?? (outcome.timedOut ? "execution timed out" : "execution exceeded output bound")) : { executionId, outcome: { kind: "completed", exitStatus: outcome.exitStatus } };
      if (group?.phase === "last" && result.outcome.kind === "completed" && result.outcome.exitStatus.code === 0) {
        delete groups.active;
        await durableJson(groupPath, groups);
      }
      return await retain({ ...result, stdout: bounded(outcome.stdout), stderr: bounded(outcome.stderr), timedOut: !!outcome.timedOut, outputTruncated: !!outcome.outputTruncated });
    } catch (error) {
      await reconcileGroup?.(message(error));
      await store.appendJournal({ kind: "evidence-failure", ...ids, executionId, actionId, state: dispatched ? "uncertain" : "refused", diagnostic: message(error) }, { durable: true });
      return await retain(response(dispatched ? "uncertain" : error instanceof AdmissionRefusedError ? "refused" : "uncertain", message(error)));
    }
  } catch (error) {
    if (ownsLock) await reconcileGroup?.(message(error)).catch(() => {
    });
    return { ...response("uncertain", `receiver error: ${message(error)}`), ...output() };
  } finally {
    try {
      await store?.close();
    } catch {
      keepLock = true;
    }
    if (ownsLock && !keepLock) await rm2(lock, { recursive: true, force: true }).catch(() => {
    });
    else if (ownsLock) await markLock(true, true).catch(() => {
    });
  }
}
async function main() {
  let result;
  try {
    const path = process.argv[2];
    if (!path) throw new Error("usage: receiver REQUEST.json (file framing; stdin is not used)");
    const file = await open(path, "r");
    let bytes;
    try {
      if ((await file.stat()).size > MAX_REQUEST_BYTES) throw new Error("request file exceeds maximum size");
      bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await file.read(bytes, length, bytes.length - length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length > MAX_REQUEST_BYTES) throw new Error("request file exceeds maximum size");
      bytes = bytes.subarray(0, length);
    } finally {
      await file.close();
    }
    result = await receive(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    result = { executionId: "unknown", imageEvidence: { status: "capture-unknown", snapshots: [] }, outcome: { kind: "refused", diagnostic: bounded(message(error)) } };
  }
  process.stdout.write(`${JSON.stringify(result)}
`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) void main();
export {
  MAX_OUTPUT_BYTES,
  MAX_REQUEST_BYTES,
  afterRequested,
  confirmProcessGroupExit,
  groupAbsentFromProcessTable,
  interpreterArgv,
  receive,
  validateImageEvidence
};
