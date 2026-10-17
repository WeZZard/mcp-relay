import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RecordStore } from "@wezzard/relay-driver-remote-runtime";
import { MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, interpreterArgv, receive, validateImageEvidence, type DispatchResult, type GuestRequest, type ReceiveOptions } from "../src/guest/receiver.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO/8AAAAASUVORK5CYII=", "base64");
const success: DispatchResult = { exitStatus: { code: 0, signal: null }, stdout: "done" };
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const request = (id: string, patch: Partial<GuestRequest> = {}): GuestRequest => ({ kind: "exec", executionId: id, sessionId: "session-test", attemptId: "attempt-test", argv: ["cua-driver", "call", "click", "--json", '{"x":10,"y":20}'], because: "A foreground interaction would interrupt the user", snapshots: { afterIntervalMs: 0 }, step: { id: "step-test", title: "Click", expected: "Button activates", inputMode: "ordinary" }, ...patch });
async function setup(t: { after(fn: () => Promise<unknown>): void }): Promise<{ root: string; options: ReceiveOptions }> {
  const root = await mkdtemp(join(tmpdir(), "pi-relay-guest-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return { root, options: { root, capture: async (out) => { await writeFile(out, png); }, dispatch: async () => success } };
}
async function journal(root: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(root, "state/journal/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
async function actions(root: string): Promise<Array<Record<string, any>>> {
  const dir = join(root, "state/records/action");
  return Promise.all((await readdir(dir)).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))));
}

test('exit-zero CUA pre-input refusal is retained and allows a new operation', async t => {
  const { root, options } = await setup(t);
  options.cuaDriver = 'cua-driver';
  let dispatches = 0;
  options.dispatch = async () => { dispatches++; return { ...success, stdout: JSON.stringify({ code: 'desktop_escalation_required', desktop_unlocked: false }) }; };
  const refused = await receive(request('driver-refused'), options);
  assert.equal(refused.outcome.kind, 'refused');
  assert.match(refused.stdout!, /desktop_escalation_required/);
  options.dispatch = async () => { dispatches++; return success; };
  const next = await receive(request('after-driver-refusal'), options);
  assert.equal(next.outcome.kind, 'completed'); assert.equal(dispatches, 2);
  assert.ok((await journal(root)).some(event => event.kind === 'execution-completion' && event.state === 'refused'));
});

test('generic CUA errors are uncertain, while generic exec JSON is not interpreted as CUA', async t => {
  const { options } = await setup(t); options.cuaDriver = 'cua-driver';
  options.dispatch = async () => ({ ...success, stdout: JSON.stringify({ isError: true, error: 'possibly partial' }) });
  assert.equal((await receive(request('ordinary-exec', { argv: ['program'] }), options)).outcome.kind, 'completed');
  assert.equal((await receive(request('driver-error'), options)).outcome.kind, 'uncertain');
});

test("admission uses substrate pairs, journals routing before dispatch, binds parent and metadata", async (t) => {
  const { root, options } = await setup(t);
  let dispatched = 0;
  options.dispatch = async (argv) => {
    dispatched++;
    assert.deepEqual(argv, request("exec-one").argv);
    const history = await journal(root);
    assert.equal(history[0]!.annotationType, "routing-decision");
    assert.equal(history[0]!.because, request("exec-one").because);
    assert.equal(history[0]!.executionId, "exec-one");
    assert.equal(history[0]!.step.expected, "Button activates");
    assert.deepEqual(history.filter((event) => event.kind === "snapshot-captured").map((event) => event.snapshot.role), ["before"]);
    assert.equal(history.find((event) => event.kind === "action-start")!.executionId, "exec-one");
    return success;
  };
  const result = await receive(request("exec-one", { snapshots: { afterIntervalMs: 15 } }), options);
  assert.equal(result.outcome.kind, "completed");
  assert.equal(result.stdout, "done");
  assert.equal(dispatched, 1);
  const [action] = await actions(root);
  assert.equal(action!.executionId, "exec-one");
  assert.equal(action!.stepId, "step-test");
  assert.equal(action!.inputMode, "ordinary");
  assert.equal(action!.state, "recorded");
  assert.deepEqual(action!.snapshots.map((s: any) => s.role), ["before", "after"]);
  assert.equal(action!.snapshots[1].declaredAfterIntervalMs, 15);
  assert.ok(action!.snapshots[1].actualWaitMs >= 15);
  for (const snapshot of action!.snapshots) {
    const bytes = await readFile(join(root, "state/snapshots/session-test", snapshot.fileName));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.sha256);
  }
  assert.deepEqual(await receive(request("exec-one"), options), result);
  assert.equal(dispatched, 1, "durable receipt lookup never replays");
});

test("required reason, snapshots and interval validation produce durable substrate refusals", async (t) => {
  const { root, options } = await setup(t);
  let dispatched = 0; options.dispatch = async () => { dispatched++; return success; };
  const patches = [{ because: "  " }, { snapshots: undefined }, { snapshots: {} }, { snapshots: { afterIntervalMs: -1 } }, { snapshots: { afterIntervalMs: Infinity } }, { snapshots: { afterIntervalMs: 300001 } }, { argv: [] }];
  for (const [index, patch] of patches.entries()) assert.equal((await receive(request(`bad-${index}`, patch), options)).outcome.kind, "refused");
  assert.equal(dispatched, 0);
  assert.equal((await journal(root)).filter((e) => e.kind === "action-refusal").length, patches.length);
  assert.equal((await actions(root)).every((a) => a.state === "refused"), true);
});

test("script and streamed-code identity mismatch refuse before capture or execution", async (t) => {
  const { root, options } = await setup(t);
  let captures = 0; options.capture = async () => { captures++; };
  options.dispatch = async () => { assert.fail("identity mismatch dispatched"); };
  const path = join(root, "test.mjs");
  await writeFile(path, "console.log('hello')");
  for (const req of [
    request("bad-code", { kind: "code", language: "javascript", code: "hello", codeSha256: "0".repeat(64) }),
    request("bad-script", { kind: "script", language: "javascript", remotePath: path, argv: ["node", path], scriptSha256: "0".repeat(64) }),
    request("wrong-script", { kind: "script", language: "javascript", remotePath: path, argv: ["node", "/tmp/not-the-verified-script.js"], scriptSha256: sha256("console.log('hello')") }),
  ]) assert.equal((await receive(req, options)).outcome.kind, "refused");
  assert.equal(captures, 0);
  assert.equal((await journal(root)).filter((e) => e.kind === "action-refusal").length, 3);
});

test("verified streamed code and uploaded scripts execute with the normal admission path", async (t) => {
  const { root, options } = await setup(t);
  delete options.dispatch;
  const code = "console.log('streamed-result')";
  const result = await receive(request("stream", { kind: "code", language: "javascript", code, codeSha256: sha256(code) }), options);
  assert.equal(result.outcome.kind, "completed");
  assert.equal(result.stdout, "streamed-result\n");
  const path = join(root, "uploaded.mjs"); await writeFile(path, code);
  const upload = await receive(request("uploaded", { kind: "script", language: "javascript", remotePath: path, argv: [process.execPath, path], scriptSha256: sha256(code) }), options);
  assert.equal(upload.outcome.kind, "completed");
  assert.equal(upload.stdout, "streamed-result\n");
});

test("capture failure before input refuses and permits new execution after capture repair", async (t) => {
  const { root, options } = await setup(t);
  options.capture = async () => { throw new Error("capture permission lost"); };
  options.dispatch = async () => { assert.fail("blind input"); };
  const result = await receive(request("before-fail"), options);
  assert.equal(result.outcome.kind, "refused");
  const receipt = await readFile(join(root, "state/receiver/receipts/before-fail.json"), "utf8");
  options.capture = async (out) => { await writeFile(out, png); };
  options.dispatch = async () => success;
  assert.equal((await receive(request("after-before-failure"), options)).outcome.kind, "completed");
  assert.equal(await readFile(join(root, "state/receiver/receipts/before-fail.json"), "utf8"), receipt);
});

test("missing after snapshot preserves output and allows later recorded input", async (t) => {
  const { root, options } = await setup(t);
  let captures = 0, dispatches = 0;
  options.capture = async (out) => { if (++captures === 2) return; await writeFile(out, png); };
  options.dispatch = async () => { dispatches++; return success; };
  const failed = await receive(request("after-fail"), options);
  assert.equal(failed.outcome.kind, "uncertain");
  assert.equal(failed.stdout, "done");
  assert.equal((await receive(request("recovered-next"), options)).outcome.kind, "completed");
  assert.equal(dispatches, 2);
  assert.equal((await journal(root)).some((e) => e.kind === "capture-status" && e.state === "incomplete"), true);
});

test("evidence completion write failure preserves output, never replays and permits recovery", async (t) => {
  const { root, options } = await setup(t);
  let dispatches = 0;
  options.dispatch = async () => { dispatches++; return success; };
  const mocked = t.mock.method(RecordStore.prototype, "retainActionCompletion", async () => { throw new Error("disk full during completion"); });
  const failed = await receive(request("write-failed"), options);
  assert.equal(failed.outcome.kind, "uncertain");
  assert.equal(failed.stdout, "done");
  assert.equal(failed.imageEvidence?.status, "available");
  assert.deepEqual(failed.imageEvidence?.snapshots.map(s => s.phase), ["before", "after"]);
  mocked.mock.restore();
  assert.equal((await receive(request("write-failed"), options)).outcome.kind, "uncertain");
  assert.equal((await receive(request("after-write-failure"), options)).outcome.kind, "completed");
  assert.equal(dispatches, 2);
});

test("routing journal failure prevents current dispatch and allows recovery after repair", async (t) => {
  const { options } = await setup(t);
  let dispatches = 0;
  options.dispatch = async () => { dispatches++; return success; };
  const mocked = t.mock.method(RecordStore.prototype, "appendJournal", async () => { throw new Error("journal unavailable"); });
  assert.equal((await receive(request("routing-failed"), options)).outcome.kind, "uncertain");
  mocked.mock.restore();
  assert.equal((await receive(request("routing-failed"), options)).outcome.kind, "uncertain");
  assert.equal((await receive(request("after-routing-failure"), options)).outcome.kind, "completed");
  assert.equal(dispatches, 1);
});

test("sender-declared groups remain consecutive across calls, keep individual records and forbid reuse", async (t) => {
  const { root, options } = await setup(t);
  const snap = (phase: "first" | "member" | "last", groupId = "typing"): GuestRequest["snapshots"] => ({ group: { groupId, phase, ...(phase === "last" ? { afterIntervalMs: 0 } : {}) } });
  assert.equal((await receive(request("orphan", { snapshots: snap("member") }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("first", { snapshots: snap("first") }), options)).outcome.kind, "completed");
  assert.equal((await receive(request("unrelated"), options)).outcome.kind, "refused");
  assert.equal((await receive(request("interloper", { snapshots: snap("first", "different") }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("other-attempt", { attemptId: "other", snapshots: snap("member") }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("member", { snapshots: snap("member") }), options)).outcome.kind, "completed");
  assert.equal((await receive(request("last-no-interval", { snapshots: { group: { groupId: "typing", phase: "last" } } }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("last", { snapshots: snap("last") }), options)).outcome.kind, "completed");
  assert.equal((await receive(request("reused", { snapshots: snap("first") }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("independent"), options)).outcome.kind, "completed");
  const members = (await actions(root)).filter((a) => a.groupId === "typing");
  assert.equal(members.length, 3);
  assert.deepEqual(members.map((a) => a.snapshots.length).sort(), [0, 1, 1]);
  assert.deepEqual(members.map((a) => a.snapshotRole).sort(), ["first", "last", "member"]);
  const files = await readdir(join(root, "state/snapshots/session-test"));
  assert.equal(files.length, 4, "one group pair plus one independent pair");
});

test("started identities and concurrent invocations fail closed without replay", async (t) => {
  const { root, options } = await setup(t);
  const started = join(root, "state/receiver/started"); await mkdir(started, { recursive: true });
  await writeFile(join(started, "interrupted.json"), "{}");
  assert.equal((await receive(request("interrupted"), options)).outcome.kind, "uncertain");
  let enter!: () => void, unblock!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  options.dispatch = async () => { enter(); await blocked; return success; };
  const first = receive(request("running"), options);
  await entered;
  assert.equal((await receive(request("running"), options)).outcome.kind, "uncertain");
  assert.equal((await receive(request("competing"), options)).outcome.kind, "uncertain");
  unblock(); assert.equal((await first).outcome.kind, "completed");
});

test("argv is not shell-interpreted; timeout and output bounds stop child execution", async (t) => {
  const { options } = await setup(t); delete options.dispatch;
  const literal = "$(touch /tmp/should-not-run); spaced argument";
  const argResult = await receive(request("literal", { argv: [process.execPath, "-e", "console.log(process.argv[1])", literal] }), options);
  assert.equal(argResult.stdout, `${literal}\n`);
  const timeout = await receive(request("timeout", { argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], timeoutMs: 50 }), options);
  assert.equal(timeout.outcome.kind, "uncertain");
  assert.equal(timeout.timedOut, true);
  const flood = await receive(request("flood", { argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(2000000)); setTimeout(()=>{},10000)"] }), options);
  assert.equal(flood.outcome.kind, "uncertain");
  assert.equal(flood.outputTruncated, true);
  assert.ok(Buffer.byteLength(flood.stdout ?? "") <= MAX_OUTPUT_BYTES);
});

test("bounded request and path-safe identities are rejected without creating unsafe state", async (t) => {
  const { options } = await setup(t);
  assert.equal((await receive(request("huge", { because: "a".repeat(MAX_REQUEST_BYTES + 1) }), options)).outcome.kind, "refused");
  assert.equal((await receive(request("../escape"), options)).outcome.kind, "refused");
  assert.equal((await receive(null, options)).outcome.kind, "refused");
  assert.equal((await receive({ ...request("nul"), argv: ["node\0"] }, options)).outcome.kind, "refused");
});

test("explicit diagnostic exec repairs capture without fabricating snapshot evidence", async t => {
  const { root, options } = await setup(t);
  let ready = false, dispatches = 0;
  options.capture = async out => { if (!ready) throw new Error("capture unavailable"); await writeFile(out, png); };
  options.dispatch = async argv => { dispatches++; if (argv[0] === "repair") ready = true; return { ...success, stderr: "retained stderr" }; };
  assert.equal((await receive(request("capture-broken"), options)).outcome.kind, "refused");
  const diagnostic = await receive(request("repair", { diagnostic: true, argv: ["repair"] }), options);
  assert.equal(diagnostic.outcome.kind, "completed");
  assert.equal(diagnostic.evidenceMode, "diagnostic");
  assert.equal(diagnostic.stdout, "done");
  assert.equal(diagnostic.stderr, "retained stderr");
  assert.equal(diagnostic.timeoutMs, 120000);
  const events = (await journal(root)).filter(e => e.executionId === "repair");
  assert.equal(events[0]!.annotationType, "routing-decision");
  assert.equal(events[0]!.evidenceMode, "diagnostic");
  assert.deepEqual(events.find(e => e.kind === "execution-start")!.argv, ["repair"]);
  assert.equal(events.some(e => e.kind === "snapshot-captured"), false);
  const action = (await actions(root)).find(a => a.executionId === "repair")!;
  assert.equal(action.snapshots, undefined);
  assert.equal(action.snapshotRole, undefined);
  assert.deepEqual(await receive(request("repair", { diagnostic: true }), options), diagnostic);
  assert.equal(dispatches, 1);
  assert.equal((await receive(request("capture-repaired"), options)).outcome.kind, "completed");
  assert.equal(dispatches, 2);
});

test("diagnostic is exec-only and still requires explicit intent and snapshot metadata", async t => {
  const { options } = await setup(t);
  options.dispatch = async () => { assert.fail("invalid diagnostic dispatched"); };
  for (const [index, patch] of [
    { diagnostic: true, kind: "code", language: "javascript", code: "", codeSha256: sha256("") },
    { diagnostic: true, kind: "script", language: "javascript" },
    { diagnostic: true, snapshots: undefined },
    { diagnostic: true, because: "" },
    { diagnostic: "yes" },
  ].entries()) assert.equal((await receive(request(`diagnostic-bad-${index}`, patch as Partial<GuestRequest>), options)).outcome.kind, "refused");
});

test("timeout validation and effective deadlines cover every dispatch kind", async t => {
  const { root, options } = await setup(t);
  const seen: number[] = [];
  options.dispatch = async (_argv, config) => { seen.push(config.timeoutMs); return success; };
  for (const [index, timeoutMs] of [0, -1, 0.5, NaN, Infinity, 3600001].entries()) {
    assert.equal((await receive(request(`timeout-bad-${index}`, { timeoutMs }), options)).outcome.kind, "refused");
  }
  const path = join(root, "timeout-script.js"); await writeFile(path, "");
  for (const [index, patch] of [
    {}, { diagnostic: true },
    { kind: "code", language: "javascript", code: "", codeSha256: sha256("") },
    { kind: "script", language: "javascript", remotePath: path, argv: ["node", path], scriptSha256: sha256("") },
  ].entries()) {
    const result = await receive(request(`long-timeout-${index}`, { ...patch, timeoutMs: 3600000 } as Partial<GuestRequest>), options);
    assert.equal(result.outcome.kind, "completed"); assert.equal(result.timeoutMs, 3600000);
  }
  assert.deepEqual(seen, [3600000, 3600000, 3600000, 3600000]);
});

test("timeout retains subprocess output and confirmed termination and permits diagnosis", async t => {
  const { options } = await setup(t); delete options.dispatch;
  const result = await receive(request("real-timeout", { diagnostic: true, argv: [process.execPath, "-e", "console.log('before timeout');console.error('error output');setTimeout(()=>{},10000)"], timeoutMs: 200 }), options);
  assert.equal(result.outcome.kind, "uncertain");
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 200);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(result.stdout, "before timeout\n");
  assert.equal(result.stderr, "error output\n");
  assert.equal((await receive(request("after-timeout", { diagnostic: true, argv: [process.execPath, "-e", ""] }), options)).outcome.kind, "completed");
});

test("failed coalescing groups are abandoned without rewriting their historical records", async t => {
  const { root, options } = await setup(t);
  const first = request("group-first", { snapshots: { group: { groupId: "failed-group", phase: "first" } } });
  assert.equal((await receive(first, options)).outcome.kind, "completed");
  const before = (await actions(root)).find(a => a.executionId === "group-first");
  options.capture = async () => { throw new Error("capture lost between members"); };
  assert.equal((await receive(request("group-member", { snapshots: { group: { groupId: "failed-group", phase: "member" } } }), options)).outcome.kind, "refused");
  options.capture = async out => { await writeFile(out, png); };
  assert.equal((await receive(request("after-group-failure"), options)).outcome.kind, "completed");
  assert.deepEqual((await actions(root)).find(a => a.executionId === "group-first"), before);
  assert.ok((await journal(root)).some(e => e.annotationType === "group-incomplete" && e.groupId === "failed-group"));
  assert.equal((await receive(request("reuse-failed", { snapshots: first.snapshots }), options)).outcome.kind, "refused");
});

test("diagnostic interruption and nonzero group results allow later new operations", async t => {
  const { root, options } = await setup(t);
  const group = (groupId: string): GuestRequest["snapshots"] => ({ group: { groupId, phase: "first" } });
  assert.equal((await receive(request("open-group", { snapshots: group("interrupted-group") }), options)).outcome.kind, "completed");
  assert.equal((await receive(request("inspect-open", { diagnostic: true }), options)).outcome.kind, "completed");
  options.dispatch = async () => ({ exitStatus: { code: 7, signal: null }, stdout: "failed command" });
  const nonzero = await receive(request("nonzero-group", { snapshots: group("nonzero-group") }), options);
  assert.equal(nonzero.outcome.kind, "completed");
  if (nonzero.outcome.kind === "completed") assert.equal(nonzero.outcome.exitStatus.code, 7);
  options.dispatch = async () => success;
  assert.equal((await receive(request("after-nonzero"), options)).outcome.kind, "completed");
  assert.equal((await journal(root)).filter(e => e.annotationType === "group-incomplete").length, 2);
});

test("stale locks require dead-owner and inactive-operation proof; ambiguous refusals do not persist", async t => {
  const { root, options } = await setup(t);
  const lock = join(root, ".receiver-lock");
  // Obtain a real, reaped PID rather than guessing an unused number.
  const deadPid = await new Promise<number>((resolvePid, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("error", reject); child.on("close", () => resolvePid(child.pid!));
  });
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid, active: true }));
  const blocked = await receive(request("stale-ambiguous"), options);
  assert.equal(blocked.outcome.kind, "uncertain");
  assert.match(blocked.outcome.diagnostic, /unconfirmed/);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, active: false }));
  assert.equal((await receive(request("live-owner"), options)).outcome.kind, "uncertain");
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid, active: false }));
  assert.equal((await receive(request("reconciled-lock"), options)).outcome.kind, "completed");
  assert.equal((await receive(request("after-lock-recovery"), options)).outcome.kind, "completed");
  assert.ok((await readdir(root)).some(name => name.startsWith(".receiver-lock-retired-")));
});

test("stale active locks require proof that all recorded process groups have exited", async t => {
  const { root, options } = await setup(t);
  const lock = join(root, ".receiver-lock");
  const deadPid = await new Promise<number>((resolvePid, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { detached: true });
    child.on("error", reject); child.on("close", () => resolvePid(child.pid!));
  });
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid, active: true, operationPids: [deadPid], pendingSpawn: true }));
  assert.equal((await receive(request("spawn-window"), options)).outcome.kind, "uncertain");
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid, active: true, operationPids: [deadPid], pendingSpawn: false }));
  assert.equal((await receive(request("dead-operation"), options)).outcome.kind, "completed");
});

test("damaged journals are preserved byte-for-byte and cannot admit diagnostic or visual commands", async t => {
  const { root, options } = await setup(t);
  await mkdir(join(root, "state/journal"), { recursive: true });
  const path = join(root, "state/journal/events.jsonl");
  const original = '{"kind":"annotation","seq":0}\n{"torn":';
  await writeFile(path, original);
  options.dispatch = async () => { assert.fail("damaged recording dispatched"); };
  for (const diagnostic of [false, true]) {
    const result = await receive(request(`damaged-${diagnostic}`, { diagnostic }), options);
    assert.equal(result.outcome.kind, "uncertain");
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("a timed-out last group member remains incomplete and does not block new groups", async t => {
  const { root, options } = await setup(t);
  assert.equal((await receive(request("timeout-first", { snapshots: { group: { groupId: "timeout-group", phase: "first" } } }), options)).outcome.kind, "completed");
  options.dispatch = async () => ({ exitStatus: { code: null, signal: "SIGKILL" }, timedOut: true, terminationConfirmed: true, stdout: "partial" });
  const failed = await receive(request("timeout-last", { snapshots: { group: { groupId: "timeout-group", phase: "last", afterIntervalMs: 0 } }, timeoutMs: 10 }), options);
  assert.equal(failed.outcome.kind, "uncertain");
  assert.equal(failed.stdout, "partial");
  assert.ok((await journal(root)).some(e => e.annotationType === "group-incomplete"));
  options.dispatch = async () => success;
  assert.equal((await receive(request("after-group-timeout"), options)).outcome.kind, "completed");
});

test("legacy failure flags are preserved as history but do not disable new input", async t => {
  const { root, options } = await setup(t);
  const path = join(root, "state/receiver/input-disabled.json");
  await mkdir(join(root, "state/receiver"), { recursive: true });
  const legacy = JSON.stringify({ diagnostic: "old capture failure" }); await writeFile(path, legacy);
  assert.equal((await receive(request("after-legacy-error"), options)).outcome.kind, "completed");
  assert.equal(await readFile(path, "utf8"), legacy);
});

test("image descriptors match original journal and bytes and survive receipt-only recovery", async t => {
  const { root, options } = await setup(t);
  let dispatches = 0, captures = 0;
  options.dispatch = async () => { dispatches++; return success; };
  options.capture = async out => { captures++; await writeFile(out, png); };
  const req = request("image-pair");
  const result = await receive(req, options);
  assert.equal(result.imageEvidence?.status, "available");
  const snapshots = result.imageEvidence!.snapshots;
  assert.deepEqual(snapshots.map(s => s.phase), ["before", "after"]);
  const events = await journal(root);
  const [action] = await actions(root);
  for (const descriptor of snapshots) {
    const original = events.find(e => e.kind === "snapshot-captured" && e.snapshot.role === descriptor.phase)!;
    assert.equal(descriptor.sessionId, req.sessionId);
    assert.equal(descriptor.attemptId, req.attemptId);
    assert.equal(descriptor.declaredAfterIntervalMs, descriptor.phase === "after" ? 0 : undefined);
    assert.equal(descriptor.executionId, req.executionId);
    assert.equal(descriptor.actionId, original.actionId);
    assert.equal(descriptor.actionId, action!.actionId);
    assert.equal(descriptor.stepId, req.step!.id);
    assert.equal(descriptor.groupId, undefined);
    assert.equal(descriptor.mimeType, "image/png");
    for (const key of ["fileName", "sha256", "bytes", "capturedAt"] as const) assert.equal(descriptor[key], original.snapshot[key]);
    const bytes = await readFile(join(root, "state/snapshots", descriptor.sessionId, descriptor.fileName));
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.sha256);
  }
  const journalBefore = await readFile(join(root, "state/journal/events.jsonl"));
  // This is the file pulled by the host after a lost transport response. It
  // needs neither another receive invocation nor a fresh display capture.
  const recovered = JSON.parse(await readFile(join(root, "state/receiver/receipts/image-pair.json"), "utf8"));
  assert.deepEqual(recovered, result);
  validateImageEvidence(recovered.imageEvidence, req, snapshots);
  assert.equal(dispatches, 1); assert.equal(captures, 2);
  assert.deepEqual(await readFile(join(root, "state/journal/events.jsonl")), journalBefore);
});

test("image evidence distinguishes partial pairs, failed execution, and unknown capture", async t => {
  const { options } = await setup(t);
  options.capture = async () => { throw new Error("before failed"); };
  const before = await receive(request("images-before-failed"), options);
  assert.deepEqual(before.imageEvidence, { status: "capture-failed", snapshots: [] });
  let captures = 0;
  options.capture = async out => { if (++captures === 2) throw new Error("after failed"); await writeFile(out, png); };
  const after = await receive(request("images-after-failed"), options);
  assert.equal(after.outcome.kind, "uncertain");
  assert.equal(after.imageEvidence?.status, "capture-failed");
  assert.deepEqual(after.imageEvidence?.snapshots.map(s => s.phase), ["before"]);
  options.capture = async out => { await writeFile(out, png); };
  options.dispatch = async () => ({ ...success, exitStatus: { code: 9, signal: null } });
  const nonzero = await receive(request("images-nonzero", { step: undefined }), options);
  assert.equal(nonzero.imageEvidence?.status, "available");
  assert.deepEqual(nonzero.imageEvidence?.snapshots.map(s => s.phase), ["before", "after"]);
  assert.equal(nonzero.imageEvidence?.snapshots[0]?.stepId, undefined);
  const refused = await receive(request("images-invalid", { argv: [] }), options);
  assert.deepEqual(refused.imageEvidence, { status: "capture-unknown", snapshots: [] });
  options.dispatch = async () => { throw new Error("dispatch failed"); };
  const thrown = await receive(request("images-thrown"), options);
  assert.equal(thrown.outcome.kind, "uncertain");
  assert.equal(thrown.imageEvidence?.status, "available");
  assert.deepEqual(thrown.imageEvidence?.snapshots.map(s => s.phase), ["before", "after"]);
});

test("capture journal remains authoritative when action snapshot retention fails", async t => {
  const { root, options } = await setup(t);
  t.mock.method(RecordStore.prototype, "retainActionSnapshots", async () => { throw new Error("action write failed"); });
  const result = await receive(request("images-action-write-failure"), options);
  assert.equal(result.outcome.kind, "uncertain");
  assert.equal(result.imageEvidence?.status, "available");
  assert.deepEqual(result.imageEvidence?.snapshots.map(s => s.phase), ["before", "after"]);
  assert.equal((await actions(root))[0]!.snapshots, undefined, "original action is not repaired or rewritten by descriptor production");
  assert.equal((await journal(root)).filter(e => e.kind === "snapshot-captured").length, 2);
});

test("group image evidence excludes readiness probes and other executions' bookends", async t => {
  const { options } = await setup(t);
  let captures = 0;
  options.capture = async out => { captures++; await writeFile(out, png); };
  for (const phase of ["first", "member", "last"] as const) {
    const req = request(`images-${phase}`, { snapshots: { group: { groupId: "image-group", phase, afterIntervalMs: 0 } } });
    const result = await receive(req, options);
    assert.equal(result.imageEvidence?.status, phase === "last" ? "available" : "not-requested");
    assert.deepEqual(result.imageEvidence?.snapshots.map(s => s.phase), phase === "first" ? ["before"] : phase === "last" ? ["after"] : []);
    for (const s of result.imageEvidence!.snapshots) { assert.equal(s.groupId, "image-group"); assert.equal(s.executionId, req.executionId); }
    validateImageEvidence(result.imageEvidence, req);
  }
  assert.equal(captures, 4, "two retained images and two unretained readiness probes");
  const diagnostic = await receive(request("images-diagnostic", { diagnostic: true }), options);
  assert.deepEqual(diagnostic.imageEvidence, { status: "not-requested", snapshots: [] });
  assert.equal(captures, 4);
});

test("descriptor validation rejects malformed, cross-execution and conflicting authoritative metadata", async t => {
  const { options } = await setup(t);
  const req = request("validate-images");
  const evidence = (await receive(req, options)).imageEvidence!;
  validateImageEvidence(evidence, req);
  for (const patch of [
    { sessionId: "foreign" }, { attemptId: "foreign" }, { executionId: "foreign" }, { actionId: "../bad" }, { stepId: "foreign" },
    { declaredAfterIntervalMs: 100 },
    { phase: "bogus" }, { groupId: "foreign" }, { capturedAt: "yesterday" }, { sha256: "bad" },
    { bytes: 0 }, { bytes: 64 * 1024 * 1024 + 1 }, { bytes: 1.5 }, { mimeType: "text/plain" },
    { fileName: "/tmp/secret.png" }, { fileName: "../secret.png" }, { fileName: "a/b.png" },
    { fileName: "a\\b.png" }, { fileName: "a.png\u0000" },
  ]) {
    const candidate = structuredClone(evidence);
    Object.assign(candidate.snapshots[0]!, patch);
    assert.throws(() => validateImageEvidence(candidate, req), /invalid image evidence/, JSON.stringify(patch));
  }
  for (const candidate of [undefined, null, {}, { ...evidence, status: "not-requested" }, { ...evidence, snapshots: [] }, { ...evidence, snapshots: [evidence.snapshots[1], evidence.snapshots[1]] }]) {
    assert.throws(() => validateImageEvidence(candidate, req), /invalid image evidence/);
  }
  for (const patch of [{ sha256: "0".repeat(64) }, { actionId: "other-action" }, { fileName: "other.png" }, { bytes: 1 }, { capturedAt: "2026-01-01T00:00:00.000Z" }]) {
    const candidate = structuredClone(evidence);
    Object.assign(candidate.snapshots[0]!, patch);
    assert.throws(() => validateImageEvidence(candidate, req, evidence.snapshots), /invalid image evidence/);
  }
  assert.throws(() => validateImageEvidence(evidence, request(req.executionId, { diagnostic: true })), /invalid image evidence/);
});

async function cli(path: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/guest/receiver.ts"), path], { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => resolveResult({ stdout, stderr, code }));
  });
}

test("file-argument CLI emits exactly one framed response and captures through configurable cua CLI", async (t) => {
  const { root } = await setup(t);
  const driver = join(root, "fake-cua");
  await writeFile(driver, `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv[2]!=='call'||process.argv[3]!=='get_desktop_state'||process.argv[4]!=='--json')process.exit(2);const args=JSON.parse(process.argv[5]);fs.writeFileSync(args.screenshot_out_file,Buffer.from('${png.toString("base64")}','base64'));console.log(JSON.stringify({screenshot_file_path:args.screenshot_out_file}));`);
  await chmod(driver, 0o700);
  const path = join(root, "request.json");
  await writeFile(path, JSON.stringify(request("cli", { argv: [process.execPath, "-e", "console.log('cli result')"] })));
  const env = { ...process.env, RELAY_RUNTIME_ROOT: root, RELAY_CUA_DRIVER: driver };
  const result = await cli(path, env);
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).outcome.kind, "completed");
  assert.equal(JSON.parse(result.stdout).stdout, "cli result\n");
  await writeFile(path, "a".repeat(MAX_REQUEST_BYTES + 1));
  const oversized = await cli(path, env);
  assert.equal(JSON.parse(oversized.stdout).outcome.kind, "refused");
});

test("a run on an image without capture software takes no snapshots, owes none and completes (DC-13)", async t => {
  const { root, options } = await setup(t);
  let captures = 0;
  options.capture = async (out) => { captures++; await writeFile(out, png); };
  const result = await receive(request("uncaptured", { capture: false, argv: ["program"] }), options);
  assert.deepEqual(result.outcome, { kind: "completed", exitStatus: { code: 0, signal: null } });
  assert.deepEqual(result.imageEvidence, { status: "not-requested", snapshots: [] });
  assert.equal(captures, 0, "nothing was captured");
  const events = await journal(root);
  assert.equal(events.some(event => event.kind === "snapshot-captured"), false);
  assert.equal(events.find(event => event.kind === "action-start")?.snapshotPlan, undefined, "no snapshot plan is declared");
  assert.equal(events.find(event => event.kind === "execution-start")?.capture, false, "the record says the run took no snapshots by design");
  // A coalescing group needs capture; without it the group is not opened, so a later run is not refused.
  assert.equal((await receive(request("uncaptured-group", { capture: false, argv: ["program"], snapshots: { group: { groupId: "g1", phase: "first" } } }), options)).outcome.kind, "completed");
  assert.equal((await receive(request("uncaptured-next", { capture: false, argv: ["program"] }), options)).outcome.kind, "completed");
  assert.equal(captures, 0);
  // Saved image evidence that claims a snapshot for such a run is invalid.
  assert.throws(() => validateImageEvidence({ status: "available", snapshots: [] }, request("x", { capture: false })), /invalid image evidence/);
  assert.equal((await receive(request("bad-capture", { capture: "no" as never, argv: ["program"] }), options)).outcome.kind, "refused");
});

test("a script runs with its language's runtime, TypeScript with tsx or else Node.js type stripping, and a missing runtime is refused (DC-25)", async () => {
  const has = (...names: string[]) => async (name: string) => names.includes(name);
  const node = (version: string, strips = false) => ({ execPath: "/guest/node", version, strips });
  assert.deepEqual(await interpreterArgv("javascript", "s.js", has(), node("22.23.2")), ["/guest/node", "s.js"]);
  assert.deepEqual(await interpreterArgv("python", "s.py", has("python3"), node("22.23.2")), ["python3", "s.py"]);
  await assert.rejects(interpreterArgv("python", "s.py", has(), node("22.23.2")), /python3 is not on the guest's PATH/);
  assert.deepEqual(await interpreterArgv("typescript", "s.ts", has("tsx"), node("22.23.2")), ["tsx", "s.ts"]);
  assert.deepEqual(await interpreterArgv("typescript", "s.ts", has(), node("22.23.2")), ["/guest/node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "s.ts"]);
  assert.deepEqual(await interpreterArgv("typescript", "s.ts", has(), node("24.1.0", true)), ["/guest/node", "--disable-warning=ExperimentalWarning", "s.ts"]);
  await assert.rejects(interpreterArgv("typescript", "s.ts", has(), node("22.5.1")), /no tsx on its PATH, and its Node\.js 22\.5\.1 predates type stripping/);
});

test("without tsx, a TypeScript script runs with this Node.js's type stripping and completes (DC-25)", async () => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) return;
  const dir = await mkdtemp(join(tmpdir(), "relay-ts-"));
  try {
    const script = join(dir, "s.ts");
    await writeFile(script, "const n: number = 42; console.log('typed', n);\n");
    const argv = await interpreterArgv("typescript", script, async () => false);
    const out = await new Promise<string>((done, fail) => {
      const child = spawn(argv[0]!, argv.slice(1)); let text = "";
      child.stdout.on("data", chunk => { text += chunk; });
      child.on("error", fail); child.on("close", code => code === 0 ? done(text) : fail(new Error(`exit ${code}`)));
    });
    assert.equal(out.trim(), "typed 42");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
