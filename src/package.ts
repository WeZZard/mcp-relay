import { createHash } from "node:crypto";
import { lstat, readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { buildManifest, verifyPackage, type PackageManifest, type ReviewStep, type SnapshotArtifact } from "@wezzard/relay-driver-host-sdk";
import type { CommandOutput, Reason, ReviewData, StepDetail } from "./review-data.js";

export interface DeliverPackageOptions {
  packageId: string;
  sessionId: string;
  taskId: string;
}
export interface DeliveryResult {
  manifestPath: string;
  deliveryVerified: boolean;
  snapshots: "complete" | "incomplete";
  execution: "passed" | "failed" | "uncertain";
  findings: string[];
}
type Obj = Record<string, any>;
type Step = ReviewStep & { because?: string; actionId: string; inputMode: string };

type Analysis = {
  snapshots: SnapshotArtifact[];
  steps: Step[];
  incompleteGroups: Set<string>;
  findings: string[];
  completeness: DeliveryResult["snapshots"];
  execution: DeliveryResult["execution"];
  // Page-only evidence, kept out of trajectory.json so its schema is unchanged.
  details: Map<string, StepDetail>;
  outputs: { path: string; bytes: number }[];
  /** Why snapshots are not complete and execution has not passed, and the relay's own defects, in plain words, with the steps concerned and what the reader can do. */
  reasons: { snapshots: Reason[]; execution: Reason[]; defects: Reason[] };
};
// Delivery seals the raw evidence and writes nothing derived from it: the steps,
// verdicts and reasons are derived when the package is reviewed (docs/design.md,
// "Derive at review"). Earlier packages also carry derived files (summary.json,
// trajectory.json or walkthrough.json, index.html, a journal copy); they remain
// sealed records, and nothing compares them with today's derivation.
const generated = ["OPENING.txt", "manifest.json"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Obj;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${label}`);
  return value;
}
/** Strict POSIX package paths: no normalization that could hide traversal. */
function relativePath(value: unknown): string {
  const path = text(value, "package path");
  if (path.includes("\\") || /[\x00-\x1f:#?]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(`unsafe package path: ${path}`);
  }
  return path;
}
async function rootPath(rootDir: string): Promise<string> {
  const root = resolve(rootDir);
  let current = parse(root).root;
  for (const part of root.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe package directory: ${current}`);
  }
  return root;
}
async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = relativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`symlink in package: ${path}`);
    if (info.isDirectory()) result.push(...await filesUnder(root, path));
    else if (info.isFile() && info.nlink === 1) result.push(path);
    else throw new Error(`non-regular or hard-linked package artifact: ${path}`);
  }
  return result.sort();
}
async function readJson(root: string, path: string): Promise<Obj> {
  return object(JSON.parse(await readFile(join(root, relativePath(path)), "utf8")), path);
}
function snapshotPath(sessionId: string, sn: Obj): string {
  const name = relativePath(sn.fileName);
  if (name.includes("/")) throw new Error("snapshot fileName must be a basename");
  return relativePath(`state/snapshots/${relativePath(sessionId)}/${name}`);
}
function sameRef(ref: Obj, sn: SnapshotArtifact): boolean {
  return ref.sha256 === sn.sha256 && ref.bytes === sn.bytes && ref.role === sn.role &&
    ref.capturedAt === sn.capturedAt && ref.declaredAfterIntervalMs === sn.declaredAfterIntervalMs;
}
function outcomeOf(completion: Obj | undefined, refused: boolean): ReviewStep["execution"] {
  if (refused) return "refused";
  if (!completion) return "incomplete";
  if (completion.state === "uncertain" || !completion.toolOutcome) return "uncertain";
  const outcome = object(completion.toolOutcome, "tool outcome");
  if (outcome.kind === "failure") return "failed";
  if (outcome.kind !== "success") return "uncertain";
  const value = outcome.value;
  if (value && typeof value === "object") {
    if (value.timedOut || value.outputRefused || value.signal || value.exitStatus?.signal) return "failed";
    for (const code of [value.code, value.exitCode, value.exitStatus?.code]) {
      if (typeof code === "number" && code !== 0) return "failed";
      if (code === null) return "uncertain";
    }
  }
  return "completed";
}

// Known refusal/failure wins over uncertainty, just as it does in the aggregate.
// Successful receipts never repair missing or failed subprocess/action evidence.
function receiptOutcome(receipt: Obj): ReviewStep["execution"] {
  const outcome = receipt.outcome;
  if (outcome?.kind === "refused") return "refused";
  if (outcome?.kind !== "completed") return "uncertain";
  const exit = outcome.exitStatus;
  if ((typeof exit?.code === "number" && exit.code !== 0) || exit?.signal) return "failed";
  return Number.isSafeInteger(exit?.code) && exit.code === 0 && exit.signal === null ? "completed" : "uncertain";
}
function reconcileOutcome(original: ReviewStep["execution"], receipts: Obj[]): ReviewStep["execution"] {
  const outcomes = [original, ...receipts.map(receiptOutcome)];
  if (outcomes.includes("refused")) return "refused";
  if (outcomes.includes("failed")) return "failed";
  return original === "completed" && outcomes.includes("uncertain") ? "uncertain" : original;
}

async function analyze(root: string, options: DeliverPackageOptions, files: string[]): Promise<Analysis> {
  text(options.packageId, "packageId"); text(options.sessionId, "sessionId"); text(options.taskId, "taskId");
  relativePath(options.sessionId);
  const journalPath = "state/journal/events.jsonl";
  if (!files.includes(journalPath)) throw new Error("missing original state/journal/events.jsonl");
  const events = (await readFile(join(root, journalPath), "utf8")).split("\n").filter(l => l.trim()).map((l, i) => object(JSON.parse(l), `journal line ${i + 1}`));
  const starts = new Map<string, Obj>(), completions = new Map<string, Obj>(), refusals = new Map<string, Obj>();
  const actionRecords = new Map<string, Obj>();
  const findings: string[] = [];
  // One guest state belongs to one enclosure session; mixed-session state is not silently excluded.
  for (const event of events) {
    if (event.sessionId !== undefined && event.sessionId !== options.sessionId) throw new Error("journal session identity mismatch");
    for (const [kind, map] of [["action-start", starts], ["action-completion", completions], ["action-refusal", refusals]] as const) {
      if (event.kind !== kind) continue;
      const id = text(event.actionId, "actionId");
      if (map.has(id)) throw new Error(`duplicate ${kind}: ${id}`);
      map.set(id, event);
    }
  }
  for (const path of files.filter(p => /^state\/records\/actions?\/[^/]+\.json$/.test(p))) {
    const record = await readJson(root, path), id = text(record.actionId, "action record id");
    if (record.sessionId !== options.sessionId || actionRecords.has(id)) throw new Error(`invalid action record identity: ${id}`);
    actionRecords.set(id, record);
    const start = starts.get(id), completion = completions.get(id);
    if (start && record.attemptId !== start.attemptId) throw new Error(`action attempt mismatch: ${id}`);
    if (completion && record.toolOutcome !== undefined && JSON.stringify(record.toolOutcome) !== JSON.stringify(completion.toolOutcome)) throw new Error(`action outcome disagrees with journal: ${id}`);
    if (!starts.has(id) && !refusals.has(id)) findings.push(`action ${id} has no retained start or refusal`);
  }
  for (const id of completions.keys()) if (!starts.has(id)) throw new Error(`completion references unknown action ${id}`);
  const snapshots: SnapshotArtifact[] = [], byPath = new Map<string, SnapshotArtifact>();
  for (const event of events.filter(e => e.kind === "snapshot-captured")) {
    const id = text(event.actionId, "snapshot actionId"), start = starts.get(id);
    if (!start) throw new Error(`snapshot references unknown action ${id}`);
    if (events.indexOf(event) <= events.indexOf(start) || (completions.has(id) && events.indexOf(event) >= events.indexOf(completions.get(id)!))) throw new Error(`snapshot outside action interval: ${id}`);
    const sn = object(event.snapshot, "captured snapshot"), path = snapshotPath(options.sessionId, sn);
    if (byPath.has(path)) throw new Error(`duplicate snapshot capture: ${path}`);
    if (sn.role !== "before" && sn.role !== "after") throw new Error(`invalid snapshot role: ${path}`);
    if (!/^[a-f0-9]{64}$/.test(sn.sha256) || !Number.isSafeInteger(sn.bytes) || sn.bytes < 0) throw new Error(`invalid capture integrity: ${path}`);
    if (!Number.isFinite(Date.parse(text(sn.capturedAt, "capture timestamp")))) throw new Error(`invalid capture timestamp: ${path}`);
    if (sn.role === "after" && (typeof sn.declaredAfterIntervalMs !== "number" || !Number.isFinite(sn.declaredAfterIntervalMs) || sn.declaredAfterIntervalMs < 0)) throw new Error(`invalid declared after interval: ${path}`);
    const plan = start.snapshotPlan;
    if (!plan || (event.group ?? undefined) !== plan.group?.groupId) throw new Error(`snapshot group/plan mismatch: ${id}`);
    if (event.attemptId !== start.attemptId) throw new Error(`snapshot attempt mismatch: ${id}`);
    if ((sn.role === "before" && !plan.capturesBefore) || (sn.role === "after" && (!plan.capturesAfter || plan.capturesAfter.afterIntervalMs !== sn.declaredAfterIntervalMs))) throw new Error(`snapshot contradicts declared plan: ${id}`);
    if (!files.includes(path)) throw new Error(`missing captured original: ${path}`);
    const bytes = await readFile(join(root, path));
    // buildManifest hashes current bytes, not the capture-time claim. Check that claim FIRST.
    if (bytes.length !== sn.bytes || hash(bytes) !== sn.sha256) throw new Error(`capture integrity mismatch: ${path}`);
    const artifact: SnapshotArtifact = { path, sha256: sn.sha256, bytes: sn.bytes, actionId: id, role: sn.role,
      capturedAt: sn.capturedAt, provenance: "dispatch-captured", ...(event.group ? { groupId: text(event.group, "groupId") } : {}),
      ...(sn.declaredAfterIntervalMs !== undefined ? { declaredAfterIntervalMs: sn.declaredAfterIntervalMs } : {}) };
    snapshots.push(artifact); byPath.set(path, artifact);
  }
  for (const path of files.filter(p => p.startsWith("state/snapshots/") && !p.endsWith(".part"))) {
    if (!byPath.has(path)) throw new Error(`snapshot original has no captured journal record: ${path}`);
  }
  // Both journal snapshot-evidence and materialized action records must cite the exact captures.
  for (const record of [...actionRecords.values(), ...events.filter(e => e.kind === "snapshot-evidence")]) {
    const id = text(record.actionId, "snapshot reference actionId"), start = starts.get(id);
    if (record.snapshots === undefined) continue;
    if (!start || !Array.isArray(record.snapshots)) throw new Error(`invalid snapshot references for ${id}`);
    if ((record.groupId ?? undefined) !== start.snapshotPlan?.group?.groupId || record.snapshotRole !== start.snapshotPlan?.role) throw new Error(`action group reference mismatch: ${id}`);
    const cited = new Set<string>();
    for (const raw of record.snapshots) {
      const ref = object(raw, "snapshot reference"), path = snapshotPath(options.sessionId, ref), sn = byPath.get(path);
      if (!sn || sn.actionId !== id || !sameRef(ref, sn) || cited.has(path)) throw new Error(`invalid action snapshot reference: ${id} -> ${path}`);
      cited.add(path);
    }
    for (const sn of snapshots.filter(s => s.actionId === id)) if (!cited.has(sn.path)) findings.push(`action ${id} is missing reverse snapshot reference ${sn.path}`);
  }
  const groups = new Map<string, Obj[]>();
  for (const start of starts.values()) {
    const plan = start.snapshotPlan;
    if (plan?.group) {
      const id = text(plan.group.groupId, "group identity");
      groups.set(id, [...(groups.get(id) ?? []), start]);
    }
  }
  const incompleteGroups = new Set<string>();
  for (const [id, members] of groups) {
    const pair = snapshots.filter(s => s.groupId === id);
    const roles = members.map(m => m.snapshotPlan.role);
    const invalid = roles[0] !== "first" || roles.at(-1) !== "last" || roles.slice(1, -1).some(r => r !== "member") || members.length < 2 || new Set(members.map(m => m.attemptId)).size !== 1;
    const allStarts = [...starts.values()];
    const positions = members.map(m => allStarts.indexOf(m));
    if (invalid || positions.some((p, i) => i > 0 && p !== positions[i - 1]! + 1) || pair.length !== 2 || !pair.some(s => s.role === "before") || !pair.some(s => s.role === "after")) {
      incompleteGroups.add(id); findings.push(`coalescing group ${id} lacks a complete consecutive first/member/last causal pair`);
    }
    if (pair.filter(s => s.role === "before").length > 1 || pair.filter(s => s.role === "after").length > 1) throw new Error(`duplicate group snapshot role: ${id}`);
  }
  // Host routing intent is preserved in full; extract reasons without trusting it as execution proof.
  const hostRecords: Obj[] = events.filter(e => e.kind === "annotation" && e.annotationType === "routing-decision");
  for (const path of files.filter(p => p.startsWith("host/") && /\.jsonl?$/.test(p))) {
    const raw = await readFile(join(root, path), "utf8");
    for (const value of path.endsWith(".jsonl") ? raw.split("\n").filter(l => l.trim()).map(l => JSON.parse(l)) : [JSON.parse(raw)]) {
      if (value && typeof value === "object") hostRecords.push(value);
    }
  }
  // Load authoritative responses before deriving individual review steps. Transport
  // retains both its own verdict and the unmodified receiver frame; neither wins
  // merely because it appears first. Scope by identities, never by reusable step IDs.
  const receipts: Obj[] = [];
  const retainReceipt = (raw: unknown, envelope?: Obj) => {
    const receipt = object(raw, "execution receipt");
    for (const key of ["executionId", "actionId", "sessionId"] as const) {
      if (receipt[key] !== undefined) text(receipt[key], `receipt ${key}`);
      if (envelope?.[key] !== undefined && receipt[key] !== undefined && envelope[key] !== receipt[key]) throw new Error(`receipt ${key} identity mismatch`);
    }
    if (receipt.sessionId !== undefined && receipt.sessionId !== options.sessionId) throw new Error("receipt session identity mismatch");
    const executionId = receipt.executionId ?? envelope?.executionId;
    const actionId = receipt.actionId ?? envelope?.actionId;
    if (executionId === undefined && actionId === undefined) throw new Error("receipt lacks execution/action identity");
    receipts.push({ ...receipt, executionId, actionId });
  };
  for (const event of events.filter(e => e.kind === "execution-completion")) retainReceipt(event.response, event);
  for (const path of files.filter(p => /^(?:host\/(?:receipts|receiver-receipts)|state\/receiver\/receipts)\/[^/]+\.json$/.test(p) || /^host\/diagnostics\/[^/]+\.receipt\.json$/.test(p))) retainReceipt(await readJson(root, path));
  const routingRecords = hostRecords.filter(h => h.because !== undefined || h.request?.because !== undefined || h.step !== undefined || h.request?.step !== undefined);
  const steps: Step[] = [], used = new Set<string>(), details = new Map<string, StepDetail>(), stepsByExecution = new Map<string, string[]>();
  // Only a receipt or tool value that actually carries a command result becomes
  // the page's exit status and streams; anything else stays raw evidence.
  const commandOutput = (value: Obj | undefined, exitStatus?: Obj): CommandOutput | undefined => {
    if (!value) return undefined;
    const exit = exitStatus ?? value.outcome?.exitStatus ?? value.exitStatus;
    const stdout = typeof value.stdout === "string" ? value.stdout : typeof value.output === "string" ? value.output : undefined;
    const stderr = typeof value.stderr === "string" ? value.stderr : undefined;
    if (exit === undefined && stdout === undefined && stderr === undefined) return undefined;
    return { ...(exit ? { exit: exit.code ?? null, signal: exit.signal ?? null } : {}), ...(typeof value.timedOut === "boolean" ? { timedOut: value.timedOut } : {}), stdout, stderr };
  };
  for (const id of new Set([...starts.keys(), ...refusals.keys(), ...actionRecords.keys()])) {
    const start = starts.get(id), record = actionRecords.get(id), refusal = refusals.get(id);
    const source = start ?? refusal ?? record!;
    if (receipts.some(r => r.evidenceMode === 'diagnostic' && r.executionId === (source.executionId ?? record?.executionId))) continue;
    const plan = start?.snapshotPlan, groupId = plan?.group?.groupId;
    const pair = snapshots.filter(s => groupId ? s.groupId === groupId : s.actionId === id);
    if (pair.filter(s => s.role === "before").length > 1 || pair.filter(s => s.role === "after").length > 1) throw new Error(`duplicate action snapshot role: ${id}`);
    const before = pair.find(s => s.role === "before"), after = pair.find(s => s.role === "after");
    if (before && after && (snapshots.indexOf(before) >= snapshots.indexOf(after) || Date.parse(before.capturedAt) > Date.parse(after.capturedAt))) throw new Error(`reversed causal pair: ${id}`);
    const missingPair = !!start && (!plan || !before || !after || (groupId && incompleteGroups.has(groupId)));
    if (missingPair) findings.push(`action ${id} lacks its declared causal pair`);
    if (start && !record) findings.push(`action ${id} has no materialized action record`);
    if (pair.length && (!record?.snapshots || !events.some(e => e.kind === "snapshot-evidence" && e.actionId === id))) findings.push(`action ${id} lacks durable reverse snapshot references`);
    let execution = outcomeOf(completions.get(id), !!refusal || record?.state === "refused");
    if (execution === "completed" && (missingPair || !record || record.state !== "recorded")) execution = "uncertain";
    const rawId = source.stepId ?? record?.stepId ?? id;
    let stepId = text(rawId, "step id");
    if (used.has(stepId)) stepId = `${stepId}@${id}`;
    if (used.has(stepId)) throw new Error(`duplicate review step id: ${stepId}`);
    used.add(stepId);
    const executionId = source.executionId ?? record?.executionId;
    const exactHost = routingRecords.find(h => h.actionId === id || (executionId && (h.executionId === executionId || h.request?.executionId === executionId)));
    const fallback = routingRecords.filter(h => source.stepId && (h.stepId === source.stepId || h.step?.id === source.stepId || h.request?.step?.id === source.stepId));
    // Copies of the same execution's routing metadata are not ambiguous, but
    // different executions sharing a human step ID must never borrow intent.
    const fallbackIdentities = new Set(fallback.map(h => h.executionId ?? h.request?.executionId ?? h.actionId ?? h));
    const candidate = fallbackIdentities.size === 1 ? fallback[0] : undefined;
    const host = exactHost ?? (candidate && (!candidate.actionId || candidate.actionId === id) && (!executionId || !(candidate.executionId ?? candidate.request?.executionId) || (candidate.executionId ?? candidate.request?.executionId) === executionId) ? candidate : undefined);
    const because = source.because ?? host?.because ?? host?.request?.because;
    const actionReceipts = receipts.filter(r => (r.actionId === id || (executionId && r.executionId === executionId)) && (r.actionId === undefined || r.actionId === id) && (r.executionId === undefined || executionId === undefined || r.executionId === executionId));
    execution = reconcileOutcome(execution, actionReceipts);
    const completion = completions.get(id);
    const argv = events.find(e => e.kind === "execution-start" && executionId && e.executionId === executionId && Array.isArray(e.argv))?.argv;
    details.set(stepId, { at: source.writtenAt ?? before?.capturedAt, beforeAt: before?.capturedAt, afterAt: after?.capturedAt,
      ...(argv?.every((w: unknown) => typeof w === "string") ? { argv } : {}),
      output: commandOutput(actionReceipts.find(r => commandOutput(r)) ?? completion?.toolOutcome?.value) });
    const originalObserved = refusal?.diagnostic ?? completion?.diagnostic ?? (completion?.toolOutcome ? JSON.stringify(completion.toolOutcome) : undefined);
    const observed = actionReceipts.length
      ? `Authoritative receipt outcomes: ${JSON.stringify(actionReceipts.map(r => ({ executionId: r.executionId, actionId: r.actionId, execution: receiptOutcome(r), outcome: r.outcome })))}\nOriginal subprocess/action evidence (not an authoritative input-success verdict): ${JSON.stringify({ refusal: refusal?.diagnostic, state: completion?.state, diagnostic: completion?.diagnostic, toolOutcome: completion?.toolOutcome })}`
      : originalObserved;
    if (executionId) stepsByExecution.set(executionId, [...(stepsByExecution.get(executionId) ?? []), stepId]);
    steps.push({ id: stepId, actionId: id, inputMode: source.inputMode ?? record?.inputMode ?? 'unknown', attemptId: source.attemptId ?? "unknown-attempt", title: source.title ?? record?.title ?? id,
      execution, state: record?.state ?? source.state ?? "unknown", expected: host?.step?.expected ?? host?.request?.step?.expected,
      observed,
      ...(typeof because === "string" ? { because } : {}), ...(pair.length ? { snapshots: { before: before?.path, after: after?.path, groupId, declaredAfterIntervalMs: after?.declaredAfterIntervalMs } } : {}) });
  }
  // Diagnostic execution is command evidence, not visual evidence: it takes no
  // screenshots and runs outside the guest receiver, by design, so neither is a
  // gap. Include it explicitly rather than hiding setup/repair merely because it has no action pair.
  const diagnostics = new Map<string, Obj>();
  for (const receipt of receipts.filter(r => r.evidenceMode === 'diagnostic')) diagnostics.set(text(receipt.executionId, 'diagnostic execution id'), receipt);
  for (const [executionId, receipt] of diagnostics) {
    const request = hostRecords.find(h => h.executionId === executionId && (h.diagnostic === true || h.evidenceMode === 'diagnostic') && h.argv);
    const stepId = `diagnostic-${executionId}`;
    if (used.has(stepId)) throw new Error(`duplicate diagnostic review step: ${stepId}`);
    used.add(stepId);
    details.set(stepId, { at: typeof request?.at === "string" ? request.at : undefined,
      ...(Array.isArray(request?.argv) && request.argv.every((w: unknown) => typeof w === "string") ? { argv: request.argv } : {}),
      output: commandOutput(receipt) });
    stepsByExecution.set(executionId, [...(stepsByExecution.get(executionId) ?? []), stepId]);
    steps.push({ id: stepId, actionId: executionId, inputMode: 'diagnostic', attemptId: request?.attemptId ?? executionId,
      title: request?.step?.title ?? 'Diagnostic command', execution: receiptOutcome(receipt), state: 'diagnostic',
      because: request?.because, expected: request?.step?.expected,
      observed: `No screenshot evidence. ${JSON.stringify({ outcome: receipt.outcome, ...(receipt.output !== undefined ? { output: receipt.output } : { stdout: receipt.stdout, stderr: receipt.stderr }), timeoutMs: receipt.timeoutMs })}` });
  }
  if (events.some(e => ["evidence-failure", "capture-status", "resource-stop"].includes(e.kind) && ["incomplete", "uncertain"].includes(e.state))) findings.push("journal records incomplete evidence or a resource stop");
  if (files.some(p => p.startsWith("state/snapshots/") && p.endsWith(".part"))) findings.push("unfinished snapshot originals retained");
  for (const request of hostRecords.filter(h => typeof h.because === "string" && typeof h.executionId === "string" && !diagnostics.has(h.executionId))) {
    if (![...starts.values()].some(s => s.executionId === request.executionId) && !events.some(e => e.kind === "execution-completion" && e.executionId === request.executionId) && !receipts.some(r => r.executionId === request.executionId && r.outcome?.kind === "refused")) {
      findings.push(`request ${request.executionId} has no retained guest execution`);
    }
  }
  // Each finding bears on one verdict, or is a defect of the relay's own records
  // that no verdict depends on (docs/design.md, "Actionable verdicts").
  const bearing = (finding: string) => /^action \S+ (has no retained start or refusal|is missing reverse snapshot reference |has no materialized action record|lacks durable reverse snapshot references)/.test(finding) ? "defects"
    : /^request \S+ has no retained guest execution$/.test(finding) ? "execution" : "snapshots";
  const explained = (key: string) => findings.filter(f => bearing(f) === key).map(finding => explainFinding(finding, steps, stepsByExecution));
  const snapshotReasons = explained("snapshots"), unexecuted = explained("execution"), defectReasons = explained("defects");
  const completeness = snapshotReasons.length ? "incomplete" : "complete";
  const receiptFailed = receipts.some(r => ["refused", "failed"].includes(receiptOutcome(r)));
  const receiptUncertain = receipts.some(r => receiptOutcome(r) === "uncertain");
  // A step without its snapshots is already uncertain itself, so incomplete
  // snapshots do not make the whole run uncertain.
  const execution = receiptFailed || steps.some(s => s.execution === "failed" || s.execution === "refused") ? "failed" : receiptUncertain || !steps.length || unexecuted.length || steps.some(s => s.execution !== "completed") ? "uncertain" : "passed";
  if (receiptFailed) findings.push("retained execution receipt reports refusal or failure");
  if (receiptUncertain) findings.push("retained execution receipt reports uncertainty");
  const failedSteps = steps.filter(s => s.execution === "failed" || s.execution === "refused").map(s => s.id);
  const unsettled = steps.filter(s => !["completed", "failed", "refused"].includes(s.execution)).map(s => s.id);
  const receiptSteps = (outcomes: string[]) => [...new Set(receipts.filter(r => outcomes.includes(receiptOutcome(r)))
    .flatMap(r => [...(stepsByExecution.get(r.executionId) ?? []), ...steps.filter(s => s.actionId === r.actionId).map(s => s.id)]))];
  const rerun = "Look for its effect in the next step's before snapshot, or run the task again.";
  // The same conditions, in the same order, as the execution verdict above.
  const executionReasons: Reason[] = execution === "passed" ? [] : [
    ...(failedSteps.length ? [{ text: "The guest refused or failed these steps.", stepIds: failedSteps, action: "Open each step to read what the guest reported, correct the cause, and run the task again." }] : []),
    ...(receiptFailed ? [{ text: "A retained receipt reports that the guest refused or failed an execution.", stepIds: receiptSteps(["refused", "failed"]), action: "Open the step to read the receipt, correct the cause, and run the task again." }] : []),
    ...(execution === "uncertain" && receiptUncertain ? [{ text: "A retained receipt cannot confirm whether the guest ran an execution, for example because the connection was lost.", stepIds: receiptSteps(["uncertain"]), action: rerun }] : []),
    ...(execution === "uncertain" && !steps.length ? [{ text: "The package holds no steps, so there is nothing whose execution could be confirmed.", stepIds: [], action: "Run the task again; this run recorded nothing." }] : []),
    ...(execution === "uncertain" ? unexecuted : []),
    ...(execution === "uncertain" && unsettled.length ? [{ text: "The relay cannot confirm these steps' outcomes: they reported none, or they lack the snapshots that would show it.", stepIds: unsettled, action: "Look for each step's effect in the next step's before snapshot, or run the task again." }] : []),
  ];
  const outputs: Analysis["outputs"] = [];
  for (const path of files.filter(p => p.startsWith("extractions/")).sort()) outputs.push({ path, bytes: (await lstat(join(root, path))).size });
  return { snapshots, steps, incompleteGroups, findings, completeness, execution, details, outputs, reasons: { snapshots: snapshotReasons, execution: executionReasons, defects: defectReasons } };
}

// Each finding in plain words, with the steps it concerns and what the reader
// can do about it. A finding the page cannot explain is shown as recorded.
function explainFinding(finding: string, steps: Step[], byExecution: Map<string, string[]>): Reason {
  const ofAction = (id: string) => steps.filter(s => s.actionId === id).map(s => s.id);
  const ofExecution = (id: string) => byExecution.get(id) ?? [];
  const checkStep = "Check the step another way, by its output or the next step's before snapshot, or run the task again.";
  const checkRun = "Check the steps around it by their output, or run the task again.";
  const report = "Nothing in this review depends on it. Report it as an mcp-relay issue, with this package.";
  const rules: [RegExp, (m: RegExpExecArray) => Reason][] = [
    [/^request (\S+) has no retained guest execution$/, m => ({ stepIds: ofExecution(m[1]!),
      text: "The relay sent a request that the guest's event journal never recorded starting or finishing, so whether it ran is unknown.", action: "Look for its effect in the next step's before snapshot, or run the task again." })],
    [/^action (\S+) lacks its declared causal pair$/, m => ({ stepIds: ofAction(m[1]!), text: "This action's before or after snapshot is missing.", action: checkStep })],
    [/^coalescing group (\S+) lacks a complete consecutive first\/member\/last causal pair$/, m => ({ stepIds: steps.filter(s => s.snapshots?.groupId === m[1]).map(s => s.id),
      text: "These steps share one before and after pair of snapshots, and that pair is incomplete.", action: checkStep })],
    [/^journal records incomplete evidence or a resource stop$/, () => ({ stepIds: [], text: "The guest's event journal records that evidence capture was incomplete, or that a resource limit stopped it.", action: checkRun })],
    [/^unfinished snapshot originals retained$/, () => ({ stepIds: [], text: "Some snapshots were still being written when the package was assembled.", action: checkRun })],
    [/^action (\S+) has no retained start or refusal$/, m => ({ stepIds: ofAction(m[1]!), text: "The package holds this action's record, but no record that the guest started or refused it.", action: report })],
    [/^action (\S+) is missing reverse snapshot reference (.+)$/, m => ({ stepIds: ofAction(m[1]!), text: `The snapshot ${m[2]} was taken for this action, but the action's record does not refer back to it.`, action: report })],
    [/^action (\S+) has no materialized action record$/, m => ({ stepIds: ofAction(m[1]!), text: "This action started, but its action record was never written.", action: report })],
    [/^action (\S+) lacks durable reverse snapshot references$/, m => ({ stepIds: ofAction(m[1]!), text: "This action's snapshots exist, but the guest's event journal does not tie them to it.", action: report })],
  ];
  for (const [pattern, explain] of rules) {
    const m = pattern.exec(finding);
    if (m) return explain(m);
  }
  return { stepIds: [], text: finding.replace(/^./, c => c.toUpperCase()) };
}

function result(root: string, a: Analysis): DeliveryResult {
  return { manifestPath: join(root, "manifest.json"), deliveryVerified: true, snapshots: a.completeness, execution: a.execution, findings: a.findings };
}

/** The package's own files the review data lists: its seal, its opening note, and an earlier relay's derived files. */
const listedFiles = ["manifest.json", "OPENING.txt", "summary.json", "trajectory.json", "walkthrough.json"];
/** The review data of a verified package: its steps, verdicts and reasons as the relay derives them. It writes nothing. */
export async function reviewData(rootDir: string): Promise<ReviewData> {
  const root = await rootPath(rootDir), m = await readJson(root, "manifest.json"), files = await filesUnder(root);
  const options = { packageId: text(m.packageId, "package id"), sessionId: text(m.sessionId, "session id"), taskId: text(m.taskId, "task id") };
  const a = await analyze(root, options, files);
  const listed = [];
  for (const path of listedFiles.filter(p => files.includes(p))) listed.push({ path, bytes: (await lstat(join(root, path))).size });
  return { ...options, completeness: a.completeness, execution: a.execution, findings: a.findings, reasons: a.reasons, steps: a.steps,
    details: Object.fromEntries(a.details), outputs: a.outputs, files: listed };
}

/** Assemble already-pulled evidence without rewriting a single guest original. */
export async function deliverPackage(rootDir: string, options: DeliverPackageOptions): Promise<DeliveryResult> {
  const root = await rootPath(rootDir), files = await filesUnder(root);
  if (files.includes("manifest.json")) {
    const existing = await readJson(root, "manifest.json");
    if (existing.packageId !== options.packageId || existing.sessionId !== options.sessionId || existing.taskId !== options.taskId) throw new Error("existing package identity mismatch");
    return verifyDeliveredPackage(root);
  }
  for (const path of files) if (generated.includes(path)) throw new Error(`reserved package output already exists: ${path}`);
  const a = await analyze(root, options, files);
  const created: string[] = [];
  const save = async (path: string, contents: string | Buffer) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, { flag: "wx" });
    created.push(path);
  };
  try {
    await save("OPENING.txt", "Read this package's steps and verdicts with the review data export of the relay's npm package, @wezzard/mcp-relay/review-data; pi-secretary's computer-use extension shows them beside the agent's session. The steps and verdicts are derived from the evidence when you review it. Snapshot completeness and execution are separate verdicts, and the review data says why each one is not complete or passed and what you can do. Originals are under state/, host metadata under host/, and declared extractions under extractions/. manifest.json checksums every artifact except itself.\n");
    const snapshotPaths = new Set(a.snapshots.map(s => s.path)), all = await filesUnder(root);
    await save("manifest.json", json(await buildManifest({ ...options, rootDir: root, media: [], segments: [], attempts: [],
      snapshots: a.snapshots.map(s => ({ ...s, absolutePath: join(root, s.path), packagePath: s.path })),
      attachments: all.filter(p => p.startsWith("extractions/")).map(p => ({ absolutePath: join(root, p), packagePath: p, declaredType: "declared-extraction" })),
      records: all.filter(p => p !== "manifest.json" && !snapshotPaths.has(p) && !p.startsWith("extractions/")).map(p => ({ absolutePath: join(root, p), packagePath: p })) })));
    return await verifyDeliveredPackage(root);
  } catch (error) {
    // Remove only the files this attempt created, never guest originals.
    // A corrected finish attempt can rebuild after a transient delivery failure.
    for (const path of created.reverse()) await rm(join(root, path), { force: true });
    throw error;
  }
}

/** Revalidate paths BEFORE the SDK verifier opens files; then check the raw evidence is consistent. Throws on corruption. */
export async function verifyDeliveredPackage(rootDir: string): Promise<DeliveryResult> {
  const root = await rootPath(rootDir), files = await filesUnder(root);
  const m = await readJson(root, "manifest.json");
  if (m.manifestVersion !== 1 || !Array.isArray(m.records) || !Array.isArray(m.media) || !Array.isArray(m.attempts) || !Array.isArray(m.segments) || (m.snapshots !== undefined && !Array.isArray(m.snapshots)) || (m.attachments !== undefined && !Array.isArray(m.attachments))) throw new Error("invalid package manifest schema");
  if (m.media.length || m.segments.length || m.attempts.length) throw new Error("mcp-relay snapshot package cannot claim video attempts or segments");
  const manifest = m as PackageManifest;
  const artifacts = [...manifest.records, ...(manifest.snapshots ?? []), ...(manifest.attachments ?? [])], seen = new Set<string>();
  for (const raw of artifacts) {
    const artifact = object(raw, "manifest artifact"), path = relativePath(artifact.path);
    if (path === "manifest.json" || seen.has(path)) throw new Error(`duplicate/self-referential manifest artifact: ${path}`);
    seen.add(path);
    if (!files.includes(path)) throw new Error(`missing artifact: ${path}`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`invalid manifest integrity metadata: ${path}`);
    const bytes = await readFile(join(root, path));
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error(`artifact integrity mismatch: ${path}`);
  }
  for (const path of files) if (path !== "manifest.json" && !seen.has(path)) throw new Error(`unmanifested artifact: ${path}`);
  if (!seen.has("OPENING.txt")) throw new Error("missing required package output: OPENING.txt");
  const options = { packageId: manifest.packageId, sessionId: manifest.sessionId, taskId: manifest.taskId };
  const a = await analyze(root, options, files);
  const expectedAttachments = files.filter(p => p.startsWith("extractions/")).sort();
  if (JSON.stringify((manifest.attachments ?? []).map(a => a.path).sort()) !== JSON.stringify(expectedAttachments)) throw new Error("extraction attachment classification mismatch");
  const actualSnapshots = manifest.snapshots ?? [];
  if (actualSnapshots.length !== a.snapshots.length) throw new Error("snapshot manifest classification mismatch");
  for (const sn of a.snapshots) {
    const actual = actualSnapshots.find(s => s.path === sn.path);
    if (!actual || actual.actionId !== sn.actionId || actual.groupId !== sn.groupId || actual.provenance !== "dispatch-captured" || !sameRef(actual, sn)) throw new Error(`snapshot provenance mismatch: ${sn.path}`);
  }
  const acceptance = await verifyPackage(manifest, root);
  // SDK rejects half group pairs categorically. Preserve them as captured snapshots,
  // accepting only this precisely identified incompleteness (never an integrity error).
  const errors = acceptance.findings.filter(f => f.code !== "ok" && !(f.code === "state-inconsistent" && [...a.incompleteGroups].some(g => f.detail === `group ${g} does not carry exactly one before/after pair`)));
  if (errors.length) throw new Error(`package verification failed: ${errors.map(e => e.detail).join("; ")}`);
  return result(root, a);
}
