import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { absolute, nonblank, pythonExecutable, relayStateRoot, type ConfigOptions } from "./config.js";
import { spawn } from "node:child_process";
import { selectedEnvironment } from './environment.js';
import { dirname, join, resolve } from "node:path";


export interface RegistryRow {
  machine: string;
  os: string;
  taskName: string;
  agent: string;
  project: string;
  startDate: string;
}
export interface RegistryOptions extends ConfigOptions {
  path?: string;
  managedRoot?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  /** Standard-library-only flock helper; defaults to MCP_RELAY_PYTHON or PATH python3. */
  pythonExecutable?: string;
}
export class RegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "RegistryError"; }
}
const columns = ["machine", "os", "taskName", "agent", "project", "startDate"] as const;
function cells(row: RegistryRow): string[] {
  return columns.map(key => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[|\r\n\u0000-\u001f\u007f]/.test(value)) {
      throw new RegistryError(`Registry ${key} must be nonempty trimmed text without pipes or control characters`);
    }
    return value;
  });
}
function parse(line: string): string[] | undefined {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return undefined;
  return text.slice(1, -1).split("|").map(cell => cell.trim());
}
interface Line { text: string; start: number; end: number }
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index!, end: match.index! + match[0].length });
  }
  return lines;
}
function table(text: string): { rows: Line[]; insertion: number; newline: string } {
  const lines = linesOf(text);
  const sections = lines.map((line, index) => /^## Using VMs\s*$/.test(line.text) ? index : -1).filter(index => index >= 0);
  if (sections.length !== 1) throw new RegistryError("Expected exactly one '## Using VMs' section");
  const begin = sections[0]!;
  let end = lines.findIndex((line, index) => index > begin && /^#{1,2} /.test(line.text));
  if (end < 0) end = lines.length;
  const headers = lines.map((line, index) => index > begin && index < end && JSON.stringify(parse(line.text)) === JSON.stringify(["Machine", "OS", "Task Name", "Agent", "Project", "Start Date"]) ? index : -1).filter(index => index >= 0);
  if (headers.length !== 1) throw new RegistryError("Expected exactly one VM task registry table");
  const header = headers[0]!;
  const separator = lines[header + 1];
  const separatorCells = separator && parse(separator.text);
  if (!separatorCells || separatorCells.length !== 6 || !separatorCells.every(cell => /^:?-{2,}:?$/.test(cell))) {
    throw new RegistryError("Malformed VM task registry separator");
  }
  const rows: Line[] = [];
  for (let i = header + 2; i < end && lines[i]!.text.trim().startsWith("|"); i++) {
    const line = lines[i]!;
    if (parse(line.text)?.length !== 6) throw new RegistryError("Malformed VM task registry row");
    rows.push(line);
  }
  const last = rows.at(-1) ?? separator;
  return { rows, insertion: last.end, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}
/** Read-only validation shared with diagnostics; never edits or initializes. */
export function validateRegistryText(text: string): void {
  table(text);
}

export interface RegistryResolution {
  path: string;
  managed: boolean;
}

/** Read-only selection: explicit user documents must exist and parse. Only a
 * compatible home AGENTS.md is adopted; everything else uses private state. */
export function resolveRegistry(options: ConfigOptions & { path?: string; managedRoot?: string } = {}): RegistryResolution {
  const env = options.env ?? process.env;
  const root = options.managedRoot ?? selectedEnvironment(env, options.home)?.profile.relayStateDir;
  if (root !== undefined && options.path === undefined) return { path: join(absolute(root, 'managed registry root'), 'registry.md'), managed: true };
  const explicit = options.path ?? env.MCP_RELAY_REGISTRY;
  const validate = (path: string) => {
    if (!statSync(path).isFile()) throw new RegistryError("Registry target must be a regular file");
    table(readFileSync(path, "utf8"));
  };
  if (explicit !== undefined) {
    const path = options.path !== undefined ? resolve(nonblank(explicit, "Registry path")) : absolute(explicit, 'MCP_RELAY_REGISTRY');
    validate(path);
    return { path, managed: false };
  }
  const legacy = join(options.home ?? env.HOME ?? homedir(), "AGENTS.md");
  try {
    validate(legacy);
    return { path: resolve(legacy), managed: false };
  } catch (error) {
    if (!(error instanceof RegistryError) && !errno(error, "ENOENT") && !errno(error, "ENOTDIR")) throw error;
  }
  return { path: join(relayStateRoot(options), "registry.md"), managed: true };
}

/**
 * The lock beside a registry file. It keeps the name it had before the
 * project was renamed to mcp-relay (DC-16): a relay of an earlier release
 * may edit the same registry, such as ~/AGENTS.md, and both must take the
 * same lock to exclude each other.
 */
export const REGISTRY_LOCK_SUFFIX = '.mcp-vm-relay.lock';
const MANAGED_REGISTRY = `# mcp-relay task registry

## Using VMs

| Machine | OS | Task Name | Agent | Project | Start Date |
| ------- | -- | --------- | ----- | ------- | ---------- |
`;

function errno(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function bounded(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}

/** OS flock lives on a stable sidecar inode (never unlink it). A tiny Python
 * stdlib helper supplies flock on macOS, where Node has no native flock API.
 * Parent death closes stdin; helper exits and the kernel releases the lock.
 * No age-based lock stealing or PID-reuse race is involved. */
const FLOCK_HELPER = `
import fcntl, os, select, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
deadline = time.monotonic() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            sys.stderr.write("registry lock timeout")
            sys.exit(2)
        readable, _, _ = select.select([sys.stdin], [], [], min(float(sys.argv[3]), remaining))
        if readable:
            sys.exit(3)
print("locked", flush=True)
sys.stdin.buffer.read()
os.close(fd)
`;

/** Cooperative cross-process lock + atomic replacement. The full six-cell row
 * is the ownership credential. A conflicting taskName is never changed. */
export class Registry {
  readonly path: string;
  private readonly managed: boolean;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly pythonExecutable: string;
  constructor(options: RegistryOptions | string = {}) {
    if (typeof options === "string") options = { path: options };
    const registry = resolveRegistry(options);
    this.path = registry.path;
    this.managed = registry.managed;
    this.lockTimeoutMs = bounded(options.lockTimeoutMs ?? 10_000, "lockTimeoutMs");
    this.lockRetryMs = bounded(options.lockRetryMs ?? 25, "lockRetryMs");
    this.pythonExecutable = options.pythonExecutable === undefined
      ? pythonExecutable(options.env)
      : nonblank(options.pythonExecutable, "pythonExecutable");
  }

  /** Returns false when this exact row is already registered (idempotent). */
  async add(row: RegistryRow, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const desired = cells(row);
    return this.update(text => {
      const registry = table(text);
      const matching = registry.rows.filter(line => parse(line.text)![2] === row.taskName);
      if (matching.length > 0) {
        if (matching.length === 1 && JSON.stringify(parse(matching[0]!.text)) === JSON.stringify(desired)) return text;
        throw new RegistryError(`Task '${row.taskName}' is already registered by a different owner or duplicated`);
      }
      const prefix = registry.insertion > 0 && !/[\r\n]/.test(text[registry.insertion - 1]!) ? registry.newline : "";
      const added = `${prefix}| ${desired.join(" | ")} |${registry.newline}`;
      return text.slice(0, registry.insertion) + added + text.slice(registry.insertion);
    }, options.signal);
  }

  /** Returns false when absent. Never removes a row whose ownership differs. */
  async remove(row: RegistryRow, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const desired = cells(row);
    return this.update(text => {
      const registry = table(text);
      const matching = registry.rows.filter(line => parse(line.text)![2] === row.taskName);
      if (matching.length === 0) return text;
      if (matching.length !== 1 || JSON.stringify(parse(matching[0]!.text)) !== JSON.stringify(desired)) {
        throw new RegistryError(`Refusing to remove task '${row.taskName}': ownership does not match`);
      }
      const line = matching[0]!;
      return text.slice(0, line.start) + text.slice(line.end);
    }, options.signal);
  }

  private async update(transform: (text: string) => string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    // A managed file may not exist yet. Canonicalize its private parent first so
    // every first writer locks the same sidecar before initializing the file.
    if (this.managed) {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const parent = await lstat(dirname(this.path));
      if (!parent.isDirectory()) throw new RegistryError("Managed registry parent must be a directory, not a symlink");
      if ((parent.mode & 0o077) !== 0) throw new RegistryError("Managed registry parent must be private (0700); choose a private state directory. Existing directory permissions are not changed automatically.");
    }
    // Explicit user-document symlinks still update their target, not the link.
    const target = this.managed
      ? join(await realpath(dirname(this.path)), "registry.md")
      : await realpath(this.path);
    const lock = await this.lock(`${target}${REGISTRY_LOCK_SUFFIX}`, signal);
    const token = randomUUID();
    let temporary: string | undefined;
    try {
      signal?.throwIfAborted();
      if (this.managed) await this.initialize(target, lock.check);
      const before = await lstat(target);
      if (!before.isFile()) throw new RegistryError("Registry target must be a regular file");
      const original = await readFile(target, "utf8");
      const updated = transform(original);
      if (original === updated) return false;
      temporary = join(dirname(target), `.${target.split("/").at(-1)}.${token}.tmp`);
      const handle = await open(temporary, "wx", before.mode & 0o777);
      try {
        await handle.chmod(before.mode & 0o777);
        await handle.writeFile(updated, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      // Detect editors that do not participate in our lock; never knowingly clobber.
      const current = await lstat(target);
      if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || await readFile(target, "utf8") !== original) {
        throw new RegistryError("Registry changed outside its lock; retry without overwriting those changes");
      }
      lock.check();
      await rename(temporary, target);
      temporary = undefined;
      const dir = await open(dirname(target), "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } finally {
      try {
        if (temporary) await unlink(temporary).catch(error => { if (!errno(error, "ENOENT")) throw error; });
      } finally { await lock.release(); }
    }
  }

  /** Publish a complete initial table without replacing any existing path.
   * Called only under the same cooperative lock used by all row updates. */
  private async initialize(target: string, check: () => void): Promise<void> {
    try {
      await lstat(target);
      return;
    } catch (error) { if (!errno(error, "ENOENT")) throw error; }
    const temporary = join(dirname(target), `.registry.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.chmod(0o600);
        await handle.writeFile(MANAGED_REGISTRY, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      check();
      // Unlike rename, link cannot clobber a file created by a nonparticipant.
      try { await link(temporary, target); } catch (error) { if (!errno(error, "EEXIST")) throw error; }
      const dir = await open(dirname(target), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary); }
  }

  private async lock(path: string, signal?: AbortSignal): Promise<{ check(): void; release(): Promise<void> }> {
    signal?.throwIfAborted();
    const child = spawn(this.pythonExecutable, ["-u", "-c", FLOCK_HELPER, path, String(this.lockTimeoutMs / 1000), String(this.lockRetryMs / 1000)], { stdio: ["pipe", "pipe", "pipe"] });
    let closed = false;
    const exit = new Promise<void>(resolveExit => child.once("close", () => { closed = true; resolveExit(); }));
    // EPIPE may follow cancellation/crash while releasing; close remains authoritative.
    child.stdin.on("error", () => {});
    let failure: unknown;
    let acquired = false;
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(0, 4096); });
    const abort = () => { failure = signal?.reason; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new RegistryError(`Timed out waiting for registry lock ${path}`);
      child.kill("SIGTERM");
    }, this.lockTimeoutMs + 1000);
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        child.stdout.on("data", data => {
          output += String(data);
          if (output === "locked\n") { acquired = true; resolveReady(); }
          else if (output.length > 100) { failure = new RegistryError("Invalid registry lock helper response"); child.kill("SIGTERM"); }
        });
        child.once("error", error => { failure = new RegistryError("Cannot start Python flock helper", { cause: error }); });
        child.once("close", () => {
          if (!acquired) rejectReady(failure ?? new RegistryError(`Registry lock helper exited: ${stderr || "no ready response"}`));
        });
      });
    } catch (error) {
      child.stdin.end();
      await exit;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    // Hold lock through atomic commit even if the caller cancels after acquisition.
    const check = () => {
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new RegistryError("Registry lock helper died during update; lock ownership was lost");
    };
    return { check, release: async () => {
      check();
      child.stdin.end();
      await exit;
    } };
  }
}
