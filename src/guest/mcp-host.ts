import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { checkArguments } from "../json-schema.js";

/**
 * The guest-resident MCP host: a small detached process, one per lease, that
 * keeps an MCP SDK `Client` per target (cua-driver, Playwright MCP, Chrome
 * DevTools MCP) connected to that server over stdio, so a browser or a native
 * session survives between calls. It is the in-guest end of `relay_run`:
 *
 *   receiver (one per request, admission journal, snapshots)
 *     -> `mcp-host.mjs call ...` (the dispatched argv the journal records)
 *       -> this host over a Unix socket (owner-only, in the lease's guest root)
 *         -> the target server's own `tools/call`
 *
 * so every forwarded call stays on the receiver's recorded path. The host
 * never replays a call. A server that is gone before a call makes the call
 * `not-sent`; a server that dies, times out or answers malformed during a call
 * makes it `uncertain`. Bundled, guest-only CLI: never run `serve` on the
 * human's desktop.
 */
export interface TargetLaunch { command: string; args: string[]; cwd?: string; env?: Record<string, string>; platformArgs?: Partial<Record<NodeJS.Platform, string[]>> }
export interface McpHostConfig {
  /** Private state: socket, state file, lock, cached tool lists. Owner-only, outside the workspace. */
  stateDir: string;
  /** Per-call results and the targets' own output files; inside the workspace so an extraction brings it home. */
  outputDir: string;
  targets: Record<string, TargetLaunch>;
  /** Longest wait for a server to start and answer `initialize` plus `tools/list`. Default 60000. */
  startTimeoutMs?: number;
}
export type CallOutcome = "completed" | "tool-error" | "not-sent" | "uncertain";
/** Exit status of `call`, which the receiver maps back to an outcome. */
export const CALL_EXIT: Record<CallOutcome, number> = { completed: 0, "tool-error": 3, "not-sent": 4, uncertain: 5 };
export interface CallSummaryBlock { type: string; text?: string; path?: string; mimeType?: string; bytes?: number; sha256?: string; uri?: string; name?: string; truncated?: boolean }
/** The one JSON line `call` prints. Bounded well under the receiver's 64 KiB output limit. */
export interface CallSummary {
  relayRun: 1; target: string; tool: string; outcome: CallOutcome; sent: boolean; diagnostic?: string;
  isError?: boolean; content?: CallSummaryBlock[]; structuredContent?: unknown; structuredContentOmitted?: boolean;
  /** Full result (images replaced by file references), relative to the output directory. */
  resultFile?: string; truncated?: boolean;
  /** The validation failures when the guest refused the arguments. */
  errors?: string[];
  hostUnavailable?: boolean; serverStopped?: boolean;
}

export const SOCKET_NAME = "host.sock";
export const MAX_ARGS_BYTES = 64 * 1024;
export const DEFAULT_START_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_TEXT_CHARS = 32 * 1024;
const MAX_SUMMARY_BYTES = 48 * 1024;
const MAX_STRUCTURED_BYTES = 8 * 1024;
const MAX_STDERR_TAIL = 4096;
const DESKTOP_WAIT_MS = 30000;
const message = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 2000);
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const safeName = (value: string) => value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 60) || "call";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be one JSON object`);
  return value as Record<string, unknown>;
}
async function readConfig(path: string): Promise<McpHostConfig> {
  if ((await stat(path)).size > MAX_REQUEST_BYTES) throw new Error("config exceeds its size bound");
  const raw = object(JSON.parse(await readFile(path, "utf8")), "config");
  if (Object.keys(raw).some(key => !["stateDir", "outputDir", "targets", "startTimeoutMs"].includes(key))) throw new Error("unknown config field");
  for (const key of ["stateDir", "outputDir"] as const) if (typeof raw[key] !== "string" || !isAbsolute(raw[key] as string) || (raw[key] as string).includes("\0")) throw new Error(`${key} must be an absolute path`);
  const stateDir = raw.stateDir as string, outputDir = raw.outputDir as string;
  const rel = relative(outputDir, stateDir);
  if (rel === "" || !rel.startsWith("..")) throw new Error("stateDir must be outside the output directory");
  const targets = object(raw.targets, "targets");
  for (const [name, launch] of Object.entries(targets)) {
    const value = object(launch, `target ${name}`);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || typeof value.command !== "string" || !value.command || !Array.isArray(value.args) || !value.args.every(arg => typeof arg === "string" && !arg.includes("\0"))) throw new Error(`invalid launch for target ${name}`);
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || !isAbsolute(value.cwd))) throw new Error(`invalid cwd for target ${name}`);
    if (value.env !== undefined && !Object.values(object(value.env, "env")).every(v => typeof v === "string")) throw new Error(`invalid env for target ${name}`);
  }
  const startTimeoutMs = raw.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isInteger(startTimeoutMs) || (startTimeoutMs as number) < 1 || (startTimeoutMs as number) > 600_000) throw new Error("startTimeoutMs must be an integer from 1 to 600000");
  return { stateDir, outputDir, targets: targets as Record<string, TargetLaunch>, startTimeoutMs: startTimeoutMs as number };
}

/** Send one request over the host socket and read one JSON line back. The socket path is relative to `stateDir`, which keeps it under `sun_path`'s 104-byte limit whatever the lease root's length. */
export async function hostRequest(stateDir: string, request: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const previous = process.cwd();
  process.chdir(stateDir);
  let socket: Socket;
  try { socket = connect({ path: SOCKET_NAME }); } finally { process.chdir(previous); }
  return new Promise((done, reject) => {
    let buffer = "", settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else done(value); };
    const timer = setTimeout(() => finish(Object.assign(new Error("MCP host did not answer before the deadline"), { code: "HOST_DEADLINE" })), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) { try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch (error) { finish(error as Error); } }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(Object.assign(new Error("MCP host closed the connection without an answer"), { code: "HOST_CLOSED" })));
  });
}

interface Entry {
  target: string; client: Client; transport: StdioClientTransport; alive: boolean;
  tools?: Tool[]; stderrTail: string; startedAt: string; exitedAt?: string;
}

/** Run the host in the foreground (`serve`); `start` detaches it. */
export async function serveHost(configPath: string): Promise<void> {
  const config = await readConfig(configPath);
  process.umask(0o077);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  await mkdir(config.outputDir, { recursive: true });
  process.chdir(config.stateDir);
  const lock = join(config.stateDir, "server.lock");
  await mkdir(lock, { mode: 0o700 }); // Fail closed on a live or unexplained lock; `start` reconciles dead ones.
  const entries = new Map<string, Entry>();
  let server: Server | undefined, busy = false, closing = false, seq = 0;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    closing = true;
    const watchdog = setTimeout(() => process.exit(1), 10_000);
    try {
      server?.close();
      await Promise.allSettled([...entries.values()].map(entry => entry.client.close()));
      entries.clear();
      await rm(join(config.stateDir, "state.json"), { force: true });
      await rm(join(config.stateDir, SOCKET_NAME), { force: true });
      await rm(lock, { recursive: true, force: true });
    } finally { clearTimeout(watchdog); }
  })();
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

  const logFile = (target: string) => join(config.outputDir, "servers", `${safeName(target)}.log`);
  const open = async (target: string): Promise<Entry> => {
    const launch = config.targets[target];
    if (!launch) throw new Error(`no launch is configured for target ${target}`);
    await mkdir(join(config.outputDir, "servers"), { recursive: true });
    // The SDK's default environment is a small safe subset; a headed browser
    // and cua-driver need the whole guest session (DISPLAY, XAUTHORITY, HOME...).
    // On Linux this host runs under SSH, which has no display, so it borrows
    // the desktop session's display variables.
    const args = [...launch.args, ...(launch.platformArgs?.[process.platform] ?? [])];
    const env = { ...process.env, ...(process.platform === "linux" ? await waitForDesktop(process.env, Math.min(config.startTimeoutMs! / 2, DESKTOP_WAIT_MS)) : {}), ...(launch.env ?? {}) } as Record<string, string>;
    const transport = new StdioClientTransport({ command: launch.command, args, cwd: launch.cwd, env, stderr: "pipe" });
    const client = new Client({ name: "mcp-relay-guest-host", version: "1" });
    const entry: Entry = { target, client, transport, alive: true, stderrTail: "", startedAt: new Date().toISOString() };
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      entry.stderrTail = (entry.stderrTail + text).slice(-MAX_STDERR_TAIL);
      void appendFile(logFile(target), text).catch(() => {});
    });
    client.onclose = () => { entry.alive = false; entry.exitedAt ??= new Date().toISOString(); };
    await appendFile(logFile(target), `[mcp-relay] starting ${JSON.stringify([launch.command, ...args])} with DISPLAY=${env.DISPLAY ?? ""} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY ?? ""} at ${entry.startedAt}\n`).catch(() => {});
    try {
      await client.connect(transport, { timeout: config.startTimeoutMs });
      entry.tools = await listAll(client, config.startTimeoutMs!);
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`target ${target} did not start: ${message(error)}${entry.stderrTail ? `; stderr: ${entry.stderrTail.slice(-1000)}` : ""}`);
    }
    if (!entry.alive) throw new Error(`target ${target} exited during startup${entry.stderrTail ? `; stderr: ${entry.stderrTail.slice(-1000)}` : ""}`);
    entries.set(target, entry);
    return entry;
  };
  /** The live entry for a target, started on first use. A server that is gone is dropped and reported, never silently restarted in the middle of a call. */
  const live = async (target: string): Promise<{ entry?: Entry; gone?: string }> => {
    const existing = entries.get(target);
    if (existing && !existing.alive) {
      entries.delete(target);
      return { gone: `target ${target} server exited at ${existing.exitedAt ?? "an unknown time"}, before this call; nothing was sent; its session state (pages, windows, element references) is lost; the next call starts a fresh server${existing.stderrTail ? `; stderr: ${existing.stderrTail.slice(-1000)}` : ""}` };
    }
    return { entry: existing ?? await open(target) };
  };

  const call = async (request: Record<string, unknown>): Promise<CallSummary> => {
    const target = String(request.target), tool = String(request.tool);
    const base = { relayRun: 1 as const, target, tool };
    const notSent = (diagnostic: string, extra: Partial<CallSummary> = {}): CallSummary => ({ ...base, outcome: "not-sent", sent: false, diagnostic, ...extra });
    const args = request.args ?? {};
    const timeoutMs = request.timeoutMs;
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 3_600_000) return notSent("timeoutMs must be an integer from 1 to 3600000");
    if (!args || typeof args !== "object" || Array.isArray(args)) return notSent("args must be a JSON object");
    let state: Awaited<ReturnType<typeof live>>;
    try { state = await live(target); } catch (error) { return notSent(message(error)); }
    if (state.gone) return notSent(state.gone);
    const entry = state.entry!;
    const definition = entry.tools?.find(item => item.name === tool);
    if (!definition) return notSent(`target ${target} has no tool named ${tool}`);
    const check = checkArguments(definition.inputSchema, args);
    if (!check.valid) return notSent(`arguments do not match ${target}.${tool}'s input schema`, { errors: check.errors });
    if (!entry.alive) { entries.delete(target); return notSent(`target ${target} server exited before this call; nothing was sent; the next call starts a fresh server`); }
    // From here the request may reach the server: a failure must not read as "not sent".
    let result: Awaited<ReturnType<Client["request"]>>;
    try {
      result = await entry.client.request({ method: "tools/call", params: { name: tool, arguments: args as Record<string, unknown> } }, CallToolResultSchema, { timeout: timeoutMs as number, maxTotalTimeout: timeoutMs as number });
    } catch (error) {
      const local = error instanceof McpError && (error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed);
      if (error instanceof McpError && !local) {
        // The server answered with a JSON-RPC error: it responded, so this is the server's own error, not an unknown.
        return { ...base, outcome: "tool-error", sent: true, isError: true, diagnostic: `server error ${error.code}: ${message(error)}`, content: [{ type: "text", text: message(error) }] };
      }
      // Timed out, died mid-call or answered something unreadable: whatever it did
      // may have happened. Stop it so nothing it still has queued can act later.
      entries.delete(target);
      await entry.client.close().catch(() => {});
      return { ...base, outcome: "uncertain", sent: true, serverStopped: true, diagnostic: `${error instanceof McpError && error.code === ErrorCode.RequestTimeout ? `no answer within ${timeoutMs} ms` : entry.alive ? message(error) : "the server exited during the call"}; the call may have acted; it is not replayed; the server was stopped and the next call starts a fresh one${entry.stderrTail ? `; stderr: ${entry.stderrTail.slice(-1000)}` : ""}` };
    }
    const summary = await summarize(config.outputDir, target, tool, ++seq, result as Record<string, unknown>);
    // cua-driver's one proven pre-input refusal keeps its meaning over MCP too.
    if (summary.isError && refusedBeforeInput(result as Record<string, unknown>)) return { ...summary, outcome: "not-sent", diagnostic: "the server refused before any input (desktop_escalation_required)" };
    return summary;
  };

  const tools = async (request: Record<string, unknown>) => {
    const target = String(request.target);
    const state = await live(target);
    if (state.gone) throw new Error(state.gone);
    const list = state.entry!.tools ?? [];
    const file = join(config.stateDir, "tools", `${safeName(target)}.json`);
    await mkdir(join(config.stateDir, "tools"), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify({ target, listedAt: new Date().toISOString(), tools: list }));
    await writeFile(`${file}.tmp`, bytes, { mode: 0o600 }); await rename(`${file}.tmp`, file);
    return { ok: true, target, file, sha256: sha256(bytes), bytes: bytes.length, count: list.length };
  };
  const status = () => ({ ok: true, pid: process.pid, targets: Object.fromEntries(Object.keys(config.targets).map(name => {
    const entry = entries.get(name);
    return [name, entry ? (entry.alive ? { state: "running", startedAt: entry.startedAt } : { state: "exited", exitedAt: entry.exitedAt }) : { state: "not-started" }];
  })) });

  server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    const reply = (value: unknown) => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) { reply({ ok: false, error: "request exceeds its size bound" }); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      let request: Record<string, unknown>;
      try { request = object(JSON.parse(buffer.slice(0, end)), "request"); } catch (error) { reply({ ok: false, error: message(error) }); return; }
      if (request.op === "ping" || request.op === "status") { reply(status()); return; }
      if (request.op === "stop") { reply({ ok: true }); void shutdown().finally(() => process.exit(0)); return; }
      if (closing) { reply(request.op === "call" ? { relayRun: 1, target: request.target, tool: request.tool, outcome: "not-sent", sent: false, diagnostic: "MCP host is stopping" } : { ok: false, error: "MCP host is stopping" }); return; }
      // One call at a time: reject overlap instead of queueing input past its caller's deadline.
      if (busy) { reply(request.op === "call" ? { relayRun: 1, target: request.target, tool: request.tool, outcome: "not-sent", sent: false, diagnostic: "MCP host is busy with another call; nothing was sent" } : { ok: false, error: "MCP host is busy" }); return; }
      busy = true;
      const work = request.op === "call" ? call(request) : request.op === "tools" ? tools(request) : Promise.resolve({ ok: false, error: "unknown op" });
      work.then(reply, error => reply(request.op === "call" ? { relayRun: 1, target: request.target, tool: request.tool, outcome: "uncertain", sent: true, diagnostic: `MCP host error: ${message(error)}` } : { ok: false, error: message(error) }))
        .finally(() => { busy = false; });
    });
  });
  try {
    await rm(SOCKET_NAME, { force: true });
    await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(SOCKET_NAME, done); });
    await chmod(SOCKET_NAME, 0o600);
    const temporary = join(config.stateDir, `state-${process.pid}.json`);
    await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(config.stateDir, "state.json"));
  } catch (error) {
    try { await writeFile(join(config.stateDir, "startup-error.json"), JSON.stringify({ error: message(error) }), { mode: 0o600 }); }
    finally { await shutdown(); }
    throw error;
  }
}

/** The variables that tie a process to a graphical login session. */
export const DESKTOP_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"] as const;
/** Parse a `/proc/<pid>/environ` file: NUL-separated `NAME=value` pairs. */
export function parseEnviron(bytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of bytes.toString("utf8").split("\0")) { const at = pair.indexOf("="); if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1); }
  return out;
}
/**
 * The desktop session's display variables, read from a process of this user
 * that already has a display. The `cua-driver serve` daemon, which the image
 * autostarts in the desktop session, is preferred; any other process with a
 * display is the fallback. Nothing is borrowed when this process already has
 * a display, or when no such process exists.
 */
export async function desktopEnvironment(current: NodeJS.ProcessEnv, procRoot = "/proc", uid = process.getuid?.()): Promise<Record<string, string>> {
  if (current.DISPLAY || current.WAYLAND_DISPLAY) return {};
  let pids: string[];
  try { pids = (await readdir(procRoot)).filter(name => /^\d+$/.test(name)); } catch { return {}; }
  let fallback: Record<string, string> | undefined;
  for (const pid of pids) {
    try {
      if (uid !== undefined && (await stat(join(procRoot, pid))).uid !== uid) continue;
      const environ = parseEnviron(await readFile(join(procRoot, pid, "environ")));
      if (!environ.DISPLAY && !environ.WAYLAND_DISPLAY) continue;
      const picked = Object.fromEntries(DESKTOP_VARIABLES.filter(name => environ[name]).map(name => [name, environ[name]!]));
      const cmdline = (await readFile(join(procRoot, pid, "cmdline"))).toString("utf8").split("\0");
      if (/cua-driver$/.test(cmdline[0] ?? "") && cmdline[1] === "serve") return picked;
      fallback ??= picked;
    } catch { /* the process ended or is not readable */ }
  }
  return fallback ?? {};
}

/**
 * A fresh VM can answer SSH before its desktop login finishes, so a server
 * started right after acquire would find no display. Wait for the session,
 * up to `limitMs`; after that the server starts anyway and reports its own
 * error.
 */
export async function waitForDesktop(current: NodeJS.ProcessEnv, limitMs: number, procRoot = "/proc", uid = process.getuid?.()): Promise<Record<string, string>> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await desktopEnvironment(current, procRoot, uid);
    if (Object.keys(found).length || current.DISPLAY || current.WAYLAND_DISPLAY || Date.now() >= deadline) return found;
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

async function listAll(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, { timeout: timeoutMs });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** True only for cua-driver's structured `desktop_escalation_required` refusal, which it returns before dispatching any input. */
export function refusedBeforeInput(result: Record<string, unknown>): boolean {
  const code = (value: unknown) => !!value && typeof value === "object" && (value as { code?: unknown }).code === "desktop_escalation_required";
  if (code(result.structuredContent)) return true;
  const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
  return content.some(block => { if (block.type !== "text" || typeof block.text !== "string") return false; try { return code(JSON.parse(block.text)); } catch { return false; } });
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/**
 * Write the call's result to its own directory (the full result, each image
 * and binary as its own file) and return the bounded summary `call` prints.
 * Text keeps its order; images become file references the host delivers
 * inline; nothing is dropped from the result file.
 */
export async function summarize(outputDir: string, target: string, tool: string, seq: number, result: Record<string, unknown>): Promise<CallSummary> {
  const directory = join(outputDir, safeName(target), `${new Date().toISOString().replace(/[-:.]/g, "")}-${String(seq).padStart(4, "0")}-${safeName(tool)}`);
  await mkdir(directory, { recursive: true });
  const rel = (path: string) => relative(outputDir, path);
  const isError = result.isError === true;
  const content = Array.isArray(result.content) ? result.content as Array<Record<string, any>> : [];
  const stored: unknown[] = [], summary: CallSummaryBlock[] = [];
  let budget = MAX_TEXT_CHARS, truncated = false;
  const text = (value: string): { text: string; truncated?: boolean } => {
    if (value.length <= budget) { budget -= value.length; return { text: value }; }
    const cut = value.slice(0, Math.max(0, budget)); budget = 0; truncated = true;
    return { text: cut, truncated: true };
  };
  for (const [index, block] of content.entries()) {
    const n = index + 1;
    if (block.type === "text" && typeof block.text === "string") { stored.push(block); summary.push({ type: "text", ...text(block.text) }); continue; }
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      const bytes = Buffer.from(block.data, "base64");
      const extension = IMAGE_EXTENSIONS[block.mimeType] ?? (block.type === "audio" ? "audio" : "bin");
      const file = join(directory, `${block.type}-${n}.${extension}`);
      await writeFile(file, bytes);
      const reference = { type: block.type, path: rel(file), mimeType: String(block.mimeType ?? ""), bytes: bytes.length, sha256: sha256(bytes) };
      stored.push(reference); summary.push(reference); continue;
    }
    if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const resource = block.resource as Record<string, any>;
      if (typeof resource.text === "string") { stored.push(block); summary.push({ type: "resource", uri: String(resource.uri ?? ""), mimeType: resource.mimeType, ...text(resource.text) }); continue; }
      if (typeof resource.blob === "string") {
        const bytes = Buffer.from(resource.blob, "base64"), file = join(directory, `resource-${n}.bin`);
        await writeFile(file, bytes);
        const reference = { type: "resource", uri: String(resource.uri ?? ""), mimeType: resource.mimeType, path: rel(file), bytes: bytes.length, sha256: sha256(bytes) };
        stored.push(reference); summary.push(reference); continue;
      }
    }
    if (block.type === "resource_link") { stored.push(block); summary.push({ type: "resource_link", uri: String(block.uri ?? ""), name: block.name }); continue; }
    stored.push(block); summary.push({ type: String(block.type ?? "unknown") });
  }
  const resultFile = join(directory, "result.json");
  await writeFile(resultFile, JSON.stringify({ target, tool, isError, content: stored, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(result._meta !== undefined ? { _meta: result._meta } : {}) }, null, 2));
  const out: CallSummary = { relayRun: 1, target, tool, outcome: isError ? "tool-error" : "completed", sent: true, isError, content: summary, resultFile: rel(resultFile) };
  if (result.structuredContent !== undefined) {
    if (JSON.stringify(result.structuredContent).length <= MAX_STRUCTURED_BYTES) out.structuredContent = result.structuredContent;
    else out.structuredContentOmitted = true;
  }
  if (truncated) out.truncated = true;
  // Hard ceiling: JSON escaping can grow text; shed text until the line fits.
  while (Buffer.byteLength(JSON.stringify(out)) > MAX_SUMMARY_BYTES) {
    if (out.structuredContent !== undefined) { delete out.structuredContent; out.structuredContentOmitted = true; continue; }
    const longest = out.content!.filter(block => typeof block.text === "string").sort((a, b) => b.text!.length - a.text!.length)[0];
    if (!longest || !longest.text) break;
    longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2)); longest.truncated = true; out.truncated = true;
  }
  return out;
}

/** Start the host detached, or confirm the running one. A host whose recorded process is gone is cleaned up first; a live unexplained lock fails closed. */
export async function startHost(configPath: string): Promise<unknown> {
  const config = await readConfig(configPath);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  try { const status = await hostRequest(config.stateDir, { op: "ping" }, 5000); if (status?.ok) return { ok: true, pid: status.pid, alreadyRunning: true }; }
  catch { /* Not running: reconcile below. */ }
  const statePath = join(config.stateDir, "state.json");
  let recorded: { pid?: number } | undefined;
  try { recorded = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const alive = (pid: unknown) => { if (!Number.isInteger(pid) || (pid as number) < 2) return false; try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  if (recorded && alive(recorded.pid)) throw new Error(`MCP host process ${recorded.pid} is alive but not answering; stop it or destroy the VM; it is not replaced automatically`);
  // The recorded host is gone (or never wrote state): its lock, socket and state are stale.
  await rm(statePath, { force: true });
  await rm(join(config.stateDir, SOCKET_NAME), { force: true });
  if (!recorded) {
    try { await stat(join(config.stateDir, "server.lock")); throw new Error("MCP host lock exists without a state file; a start may be in progress; retry once it settles"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } else await rm(join(config.stateDir, "server.lock"), { recursive: true, force: true });
  await rm(join(config.stateDir, "startup-error.json"), { force: true });
  const entry = await realpath(fileURLToPath(import.meta.url));
  const fd = openSync(join(config.stateDir, "host.log"), "a", 0o600);
  const child = spawn(process.execPath, [entry, "serve", await realpath(configPath)], { detached: true, cwd: config.stateDir, stdio: ["ignore", fd, fd], env: { ...process.env } });
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      let detail = "MCP host exited before it was ready";
      try { detail += `: ${JSON.parse(await readFile(join(config.stateDir, "startup-error.json"), "utf8")).error}`; } catch { /* no detail */ }
      throw new Error(detail);
    }
    try { const status = await hostRequest(config.stateDir, { op: "ping" }, 2000); if (status?.ok && status.pid === child.pid) { child.unref(); return { ok: true, pid: child.pid }; } }
    catch { /* not listening yet */ }
    await sleep(25);
  }
  child.kill("SIGTERM");
  throw new Error("MCP host startup deadline exceeded");
}

/** Stop the host and every server it started. Authenticates to the live socket rather than signalling a PID read from disk. */
export async function stopHost(stateDir: string): Promise<unknown> {
  let answer: unknown;
  try { answer = await hostRequest(stateDir, { op: "stop" }, 5000); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return { ok: true, running: false };
    throw error;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await stat(join(stateDir, "state.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...(answer as object), stopped: true }; throw error; }
    await sleep(25);
  }
  throw new Error("MCP host stop did not complete; destroying the VM remains the final cleanup");
}

/** The dispatched half of `relay_run`: forward one call to the host and print one bounded JSON line. The exit status carries the outcome. */
export async function callHost(stateDir: string, target: string, tool: string, argsJson: string, timeoutMs: number, startTimeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<CallSummary> {
  const base = { relayRun: 1 as const, target, tool };
  if (Buffer.byteLength(argsJson) > MAX_ARGS_BYTES) return { ...base, outcome: "not-sent", sent: false, diagnostic: `args exceed ${MAX_ARGS_BYTES} bytes` };
  let args: unknown;
  try { args = JSON.parse(argsJson); } catch { return { ...base, outcome: "not-sent", sent: false, diagnostic: "args are not JSON" }; }
  try {
    return await hostRequest(stateDir, { op: "call", target, tool, args, timeoutMs }, timeoutMs + startTimeoutMs + 10_000) as CallSummary;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return { ...base, outcome: "not-sent", sent: false, hostUnavailable: true, diagnostic: `MCP host is not running (${code}); nothing was sent` };
    return { ...base, outcome: "uncertain", sent: true, diagnostic: `${message(error)}; the call may have reached the server; it is not replayed` };
  }
}

/** Unpack staged, hash-checked npm tarballs into one flat node_modules. Idempotent per tarball hash. */
export async function installPackages(nodeModules: string, specs: string[]): Promise<unknown> {
  const installed = [];
  for (const spec of specs) {
    const [name, tarball, expected] = spec.split("=");
    if (!name || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || !tarball || !isAbsolute(tarball) || !/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error(`invalid package spec ${spec}`);
    const destination = join(nodeModules, name), marker = join(destination, ".mcp-relay-installed.json");
    try { if (JSON.parse(await readFile(marker, "utf8")).sha256 === expected) { installed.push({ name, sha256: expected, reused: true }); continue; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (sha256(await readFile(tarball)) !== expected) throw new Error(`${name} tarball hash mismatch; not installed`);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    const result = spawnSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], { encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) throw new Error(`unpacking ${name} failed: ${result.error ? message(result.error) : result.stderr.slice(0, 1000)}`);
    await writeFile(marker, JSON.stringify({ name, sha256: expected }));
    installed.push({ name, sha256: expected });
  }
  return { ok: true, installed };
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const usage = "Usage: mcp-host.mjs start|serve <configJson> | call <stateDir> <target> <tool> <argsJson> <timeoutMs> [startTimeoutMs] | tools <stateDir> <target> | status|stop <stateDir> | install <nodeModules> <name=tarball=sha256>...";
  if (command === "serve" && rest.length === 1) { await serveHost(rest[0]!); return; }
  if (command === "call" && (rest.length === 5 || rest.length === 6)) {
    const [stateDir, target, tool, argsJson, timeout, start] = rest as [string, string, string, string, string, string?];
    const summary = await callHost(stateDir, target, tool, argsJson, Number(timeout), start === undefined ? undefined : Number(start));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = CALL_EXIT[summary.outcome] ?? CALL_EXIT.uncertain;
    return;
  }
  let result: unknown;
  if (command === "start" && rest.length === 1) result = await startHost(rest[0]!);
  else if (command === "stop" && rest.length === 1) result = await stopHost(rest[0]!);
  else if (command === "status" && rest.length === 1) result = await hostRequest(rest[0]!, { op: "status" }, 5000);
  else if (command === "tools" && rest.length === 2) {
    result = await hostRequest(rest[0]!, { op: "tools", target: rest[1] }, DEFAULT_START_TIMEOUT_MS * 2 + 10_000);
    if (!(result as { ok?: boolean })?.ok) throw new Error((result as { error?: string })?.error ?? "tools listing failed");
  } else if (command === "install" && rest.length >= 2) result = await installPackages(rest[0]!, rest.slice(1));
  else throw new Error(usage);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === await realpath(fileURLToPath(import.meta.url)).catch(() => "-")) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, error: message(error) })}\n`); process.exitCode = 1; });
}
