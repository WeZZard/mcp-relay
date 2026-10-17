#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/doctor.ts
import { access, readFile as readFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync as realpathSync2 } from "node:fs";

// src/util.ts
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
var hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function command(argv, options = {}) {
  options.signal?.throwIfAborted();
  return new Promise((resolve4, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    let stdout = "", stderr = "", size = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Command timed out: ${argv[0]}`);
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 1e4);
    const consume = (channel, chunk) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 128 * 1024)) {
        failure = new Error(`Command output exceeded limit: ${argv[0]}`);
        child.kill("SIGKILL");
        return;
      }
      if (channel === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve4({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// src/vm-service.ts
import { isIP } from "node:net";
var VmServiceError = class extends Error {
  constructor(message, status, responseBody, options) {
    super(message, options);
    this.status = status;
    this.responseBody = responseBody;
    this.name = "VmServiceError";
  }
  status;
  responseBody;
  /** The host is at capacity, such as its limit on running macOS VMs: nothing was reserved, and the same acquisition may be asked again (DC-22). */
  capacity = false;
};
function capacityRefusal(error) {
  if (!(error instanceof VmServiceError) || error.status !== 409 || !error.responseBody) return false;
  let body;
  try {
    body = JSON.parse(error.responseBody);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object") return false;
  const { error: reason, outcome } = body;
  return typeof reason === "string" && reason.startsWith("macOS VM limit reached") && outcome !== "uncertain";
}
var AcquireIndeterminateError = class extends VmServiceError {
  constructor(purpose, cause) {
    super(`Acquisition outcome unknown for purpose '${purpose}'; reconcile GET /vms before retrying or ending the enclosure`, void 0, void 0, { cause });
    this.purpose = purpose;
    this.name = "AcquireIndeterminateError";
  }
  purpose;
};
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isLease(value) {
  if (!record(value)) return false;
  return ["vm", "purpose", "image"].every((k) => typeof value[k] === "string" && value[k] !== "") && ["macos", "linux"].includes(String(value.image_kind)) && ["pending", "provisioning", "running", "releasing"].includes(String(value.state)) && ["created_at", "ttl_expires_at"].every((k) => typeof value[k] === "number" && Number.isFinite(value[k])) && ["cpu", "memory_mb", "disk_gb", "grace_until"].every((k) => value[k] === null || typeof value[k] === "number") && ["env", "ip"].every((k) => value[k] === null || typeof value[k] === "string") && typeof value.warned === "boolean";
}
var VmService = class {
  baseUrl;
  environment;
  timeoutMs;
  acquireTimeoutMs;
  maxResponseBytes;
  constructor(options = {}) {
    if (typeof options === "string") options = { baseUrl: options };
    this.environment = options.environment;
    const url = new URL(options.baseUrl ?? options.environment?.profile.vmServiceUrl ?? "http://localhost:6240");
    if (options.environment && url.origin !== new URL(options.environment.profile.vmServiceUrl).origin) throw new TypeError("Backend endpoint does not match the selected environment");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
    if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("vm-service baseUrl must be a loopback HTTP(S) origin without credentials, path, query or fragment");
    }
    this.baseUrl = url.origin;
    this.timeoutMs = positive(options.timeoutMs ?? 66e4, "timeoutMs");
    this.acquireTimeoutMs = positive(options.acquireTimeoutMs ?? 36e5, "acquireTimeoutMs");
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
  }
  health(options = {}) {
    return this.request("/health", void 0, options);
  }
  list(options = {}) {
    return this.request("/vms", void 0, options);
  }
  images(options = {}) {
    return this.request("/images", void 0, options);
  }
  applications(options = {}) {
    return this.request("/applications", void 0, options);
  }
  acquisitionCapabilities(options = {}) {
    return this.consoleRequest("/acquisition-capabilities", void 0, options);
  }
  consoleResolve(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/resolve"), body, options);
  }
  consoleOpen(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/open"), body, options);
  }
  consoleCancel(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/cancel"), body, options);
  }
  async consoleRequest(path, body, options) {
    try {
      return await this.request(path, body, options);
    } catch (error) {
      throw new VmServiceError(`Console API unavailable or request outcome unknown${error instanceof VmServiceError && error.status ? ` (HTTP ${error.status})` : ""}; resolve before another open`, error instanceof VmServiceError ? error.status : void 0);
    }
  }
  get(vm, options = {}) {
    return this.request(this.path(vm), void 0, options);
  }
  /**
   * Cancellation before dispatch prevents allocation. Once dispatched we deliberately
   * do NOT abort the request: return the lease even if the caller cancels, so its
   * finally/cleanup path can register and release it. Caller must track the returned
   * lease before checking its signal. Network loss/deadline remains indeterminate
   * (a daemon protocol limitation); never blindly retry acquisition.
   */
  async acquire(body, options = {}) {
    options.signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.purpose)) throw new TypeError("Invalid VM purpose");
    const timeoutMs = positive(options.timeoutMs ?? this.acquireTimeoutMs, "timeoutMs");
    try {
      const lease = await this.request("/acquire", body, { timeoutMs });
      if (!isLease(lease)) throw new VmServiceError("Invalid vm-service acquire response");
      return lease;
    } catch (error) {
      const safeError = body.vnc ? new VmServiceError(`VNC acquisition refused or outcome unknown${error instanceof VmServiceError && error.status ? ` (HTTP ${error.status})` : ""}; inspect capabilities and reconcile ownership`, error instanceof VmServiceError ? error.status : void 0) : error;
      if (safeError instanceof VmServiceError) safeError.capacity = capacityRefusal(error);
      if (error instanceof VmServiceError && error.status !== void 0 && error.status >= 400 && error.status < 500) throw safeError;
      throw new AcquireIndeterminateError(body.purpose, safeError);
    }
  }
  exec(vm, body, options = {}) {
    return this.request(this.path(vm, "exec"), body, options);
  }
  push(vm, body, options = {}) {
    return this.request(this.path(vm, "push"), body, options);
  }
  pull(vm, body, options = {}) {
    return this.request(this.path(vm, "pull"), body, options);
  }
  heartbeat(vm, body = {}, options = {}) {
    return this.request(this.path(vm, "heartbeat"), body, options);
  }
  release(vm, body = {}, options = {}) {
    return this.request(this.path(vm, "release"), body, options);
  }
  path(vm, action) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(vm)) throw new TypeError("Invalid VM name");
    return `/vms/${encodeURIComponent(vm)}${action ? `/${action}` : ""}`;
  }
  async request(path, body, options) {
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new VmServiceError(`vm-service ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body === void 0 ? "GET" : "POST",
        headers: { ...body === void 0 ? {} : { "Content-Type": "application/json" }, ...this.environment ? { "X-VM-Environment-Fingerprint": this.environment.identity.fingerprint } : {} },
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: controller.signal,
        redirect: "error"
        // Do not let a loopback service redirect to remote hosts.
      });
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      const bound = response.ok ? this.maxResponseBytes : Math.min(4096, this.maxResponseBytes);
      let truncated = false;
      if (reader) {
        try {
          for (; ; ) {
            const { value, done } = await reader.read();
            if (done) break;
            const remaining = bound - size;
            chunks.push(value.subarray(0, remaining));
            size += Math.min(value.byteLength, remaining);
            if (value.byteLength > remaining) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!response.ok) throw new VmServiceError(`vm-service ${path}: HTTP ${response.status}: ${text}${truncated ? " [truncated]" : ""}`, response.status, text);
      if (truncated) throw new VmServiceError(`vm-service ${path}: response exceeds ${bound} bytes`);
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw new VmServiceError(`vm-service ${path}: invalid JSON response`, void 0, void 0, { cause });
      }
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof VmServiceError) throw cause;
      throw new VmServiceError(`vm-service ${path}: request failed`, void 0, void 0, { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
};

// src/registry.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";

// src/config.ts
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute2, join as join2, normalize } from "node:path";

// src/environment.ts
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { isIP as isIP2 } from "node:net";
var paths = ["imageRepository", "tartHome", "serviceStateDir", "imageStateDir", "relayStateDir", "vmctlPath", "tartPath"];
var mutable = ["tartHome", "serviceStateDir", "imageStateDir", "relayStateDir"];
function canonicalPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.trim() || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) throw new Error("Environment paths must be absolute and contain no control characters");
  let ancestor = resolve(value);
  const suffix = [];
  for (; ; ) {
    try {
      return join(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Dangling environment path symlink");
      } catch (entryError) {
        if (entryError.code !== "ENOENT") throw entryError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
function overlaps(a, b) {
  const below = (parent, child) => {
    const r = relative(parent, child);
    return r === "" || !r.startsWith("../") && r !== ".." && !isAbsolute(r);
  };
  return below(a, b) || below(b, a);
}
function endpoint(value) {
  if (typeof value !== "string") throw new Error("vmServiceUrl must be a loopback HTTP origin with an explicit port");
  const match = /^http:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]):([0-9]{1,5})\/?$/.exec(value);
  if (!match || !["localhost", "[::1]"].includes(match[1]) && isIP2(match[1]) !== 4) throw new Error("vmServiceUrl must be a loopback HTTP origin with an explicit port");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error("Environment port must be between 1 and 65535");
  return `http://${match[1]}:${port}`;
}
function loadEnvironment(path, env = process.env, home = env.HOME ?? homedir()) {
  const canonical = canonicalPath(resolve(path));
  const info = statSync(canonical);
  if (!info.isFile() || info.size > 65536) throw new Error("Environment profile must be a regular JSON file under 64 KiB");
  const bytes = readFileSync(canonical);
  if (bytes.length > 65536) throw new Error("Environment profile exceeds 64 KiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const raw = JSON.parse(text);
  let depth = 0;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (depth === 1 && text[next] === ":") {
        const key = JSON.parse(text.slice(start, i + 1));
        if (seen.has(key)) throw new Error(`Duplicate environment profile key: ${key}`);
        seen.add(key);
      }
    } else if (text[i] === "{" || text[i] === "[") depth++;
    else if (text[i] === "}" || text[i] === "]") depth--;
  }
  const fields = ["schemaVersion", "id", "vmServiceUrl", ...paths].sort();
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(fields)) throw new Error("Environment profile has missing or unknown fields");
  const p = raw;
  if (p.schemaVersion !== 1 || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)) throw new Error("Invalid environment schemaVersion or id");
  const profile = { schemaVersion: 1, id: p.id, vmServiceUrl: endpoint(p.vmServiceUrl) };
  for (const key of paths) profile[key] = canonicalPath(p[key]);
  if (!statSync(profile.imageRepository).isDirectory() || !statSync(join(profile.imageRepository, "images")).isDirectory()) throw new Error("Selected imageRepository must contain images/");
  for (const key of ["vmctlPath", "tartPath"]) {
    if (!statSync(profile[key]).isFile()) throw new Error(`${key} must be a regular executable file`);
    accessSync(profile[key], constants.X_OK);
  }
  const state = env.XDG_STATE_HOME ? canonicalPath(env.XDG_STATE_HOME) : join(canonicalPath(home), ".local/state");
  const names = ["vm-service", "pilot-images", "mcp-relay", "mcp-vm-relay"];
  const defaults = [join(canonicalPath(home), ".tart"), ...names.map((n) => join(state, n)), ...names.map((n) => join(canonicalPath(home), ".local/state", n))].map(canonicalPath);
  for (const key of mutable) {
    const value = profile[key];
    try {
      if (!statSync(value).isDirectory()) throw new Error(`${key} must be a directory`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (overlaps(value, profile.imageRepository) || defaults.some((root) => overlaps(value, root))) throw new Error(`${key} overlaps the repository or a legacy default store/state root`);
    for (const other of mutable) if (key !== other && overlaps(value, profile[other])) throw new Error("Environment mutable roots must be disjoint");
  }
  const ordered = Object.fromEntries(Object.keys(profile).sort().map((k) => [k, profile[k]]));
  const fingerprint = createHash2("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
  const identity = Object.freeze({
    id: profile.id,
    fingerprint,
    vmServiceUrl: profile.vmServiceUrl,
    imageRepository: profile.imageRepository,
    tartHome: profile.tartHome,
    serviceStateDir: profile.serviceStateDir,
    imageStateDir: profile.imageStateDir,
    relayStateDir: profile.relayStateDir
  });
  return Object.freeze({ path: canonical, profile: Object.freeze(profile), identity });
}
function selectedEnvironment(env = process.env, home) {
  if (env.VM_ENVIRONMENT_FILE === void 0) return void 0;
  if (!env.VM_ENVIRONMENT_FILE.trim()) throw new Error("VM_ENVIRONMENT_FILE must not be blank");
  return loadEnvironment(env.VM_ENVIRONMENT_FILE, env, home);
}
function environmentVariables(selected) {
  const p = selected.profile;
  const url = new URL(p.vmServiceUrl);
  return {
    VM_ENVIRONMENT_FILE: selected.path,
    VM_ENVIRONMENT_FINGERPRINT: selected.identity.fingerprint,
    PILOT_REPO: p.imageRepository,
    TART_HOME: p.tartHome,
    VM_SERVICE_STATE: p.serviceStateDir,
    PILOT_IMAGES_STATE_DIR: p.imageStateDir,
    VM_RELAY_STATE_DIR: p.relayStateDir,
    VM_RELAY_URL: p.vmServiceUrl,
    VM_SERVICE_HOST: url.hostname.replace(/^\[|\]$/g, ""),
    VM_SERVICE_PORT: String(Number(p.vmServiceUrl.match(/:([0-9]+)$/)[1])),
    VMCTL: p.vmctlPath,
    TART: p.tartPath
  };
}
function matchesEnvironment(actual, selected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const identity = actual;
  return Object.keys(identity).length === Object.keys(selected.identity).length && Object.entries(selected.identity).every(([key, value]) => identity[key] === value);
}

// src/config.ts
function nonblank(value, label) {
  if (!value.trim() || value.includes("\0")) throw new TypeError(`${label} must be nonblank text without NUL characters`);
  return value;
}
function absolute(value, label) {
  nonblank(value, label);
  if (!isAbsolute2(value)) throw new TypeError(`${label} must be an absolute path`);
  return normalize(value);
}
function relayStateRoot(options = {}) {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return selected.profile.relayStateDir;
  if (env.MCP_RELAY_STATE_DIR !== void 0) return absolute(env.MCP_RELAY_STATE_DIR, "MCP_RELAY_STATE_DIR");
  if (env.XDG_STATE_HOME !== void 0) return join2(absolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "mcp-relay");
  return join2(absolute(options.home ?? env.HOME ?? homedir2(), "home"), ".local", "state", "mcp-relay");
}
function pythonExecutable(env = process.env) {
  return nonblank(env.MCP_RELAY_PYTHON ?? "python3", "MCP_RELAY_PYTHON");
}

// src/registry.ts
import { spawn as spawn2 } from "node:child_process";
import { dirname as dirname2, join as join3, resolve as resolve3 } from "node:path";
var RegistryError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RegistryError";
  }
};
var columns = ["machine", "os", "taskName", "agent", "project", "startDate"];
function cells(row) {
  return columns.map((key) => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[|\r\n\u0000-\u001f\u007f]/.test(value)) {
      throw new RegistryError(`Registry ${key} must be nonempty trimmed text without pipes or control characters`);
    }
    return value;
  });
}
function parse(line) {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return void 0;
  return text.slice(1, -1).split("|").map((cell) => cell.trim());
}
function linesOf(text) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}
function table(text) {
  const lines = linesOf(text);
  const sections = lines.map((line, index) => /^## Using VMs\s*$/.test(line.text) ? index : -1).filter((index) => index >= 0);
  if (sections.length !== 1) throw new RegistryError("Expected exactly one '## Using VMs' section");
  const begin = sections[0];
  let end = lines.findIndex((line, index) => index > begin && /^#{1,2} /.test(line.text));
  if (end < 0) end = lines.length;
  const headers = lines.map((line, index) => index > begin && index < end && JSON.stringify(parse(line.text)) === JSON.stringify(["Machine", "OS", "Task Name", "Agent", "Project", "Start Date"]) ? index : -1).filter((index) => index >= 0);
  if (headers.length !== 1) throw new RegistryError("Expected exactly one VM task registry table");
  const header = headers[0];
  const separator = lines[header + 1];
  const separatorCells = separator && parse(separator.text);
  if (!separatorCells || separatorCells.length !== 6 || !separatorCells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
    throw new RegistryError("Malformed VM task registry separator");
  }
  const rows = [];
  for (let i = header + 2; i < end && lines[i].text.trim().startsWith("|"); i++) {
    const line = lines[i];
    if (parse(line.text)?.length !== 6) throw new RegistryError("Malformed VM task registry row");
    rows.push(line);
  }
  const last = rows.at(-1) ?? separator;
  return { rows, insertion: last.end, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}
function validateRegistryText(text) {
  table(text);
}
function resolveRegistry(options = {}) {
  const env = options.env ?? process.env;
  const root = options.managedRoot ?? selectedEnvironment(env, options.home)?.profile.relayStateDir;
  if (root !== void 0 && options.path === void 0) return { path: join3(absolute(root, "managed registry root"), "registry.md"), managed: true };
  const explicit = options.path ?? env.MCP_RELAY_REGISTRY;
  const validate = (path) => {
    if (!statSync2(path).isFile()) throw new RegistryError("Registry target must be a regular file");
    table(readFileSync2(path, "utf8"));
  };
  if (explicit !== void 0) {
    const path = options.path !== void 0 ? resolve3(nonblank(explicit, "Registry path")) : absolute(explicit, "MCP_RELAY_REGISTRY");
    validate(path);
    return { path, managed: false };
  }
  const legacy = join3(options.home ?? env.HOME ?? homedir3(), "AGENTS.md");
  try {
    validate(legacy);
    return { path: resolve3(legacy), managed: false };
  } catch (error) {
    if (!(error instanceof RegistryError) && !errno(error, "ENOENT") && !errno(error, "ENOTDIR")) throw error;
  }
  return { path: join3(relayStateRoot(options), "registry.md"), managed: true };
}
var REGISTRY_LOCK_SUFFIX = ".mcp-vm-relay.lock";
var MANAGED_REGISTRY = `# mcp-relay task registry

## Using VMs

| Machine | OS | Task Name | Agent | Project | Start Date |
| ------- | -- | --------- | ----- | ------- | ---------- |
`;
function errno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function bounded(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}
var FLOCK_HELPER = `
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
var Registry = class {
  path;
  managed;
  lockTimeoutMs;
  lockRetryMs;
  pythonExecutable;
  constructor(options = {}) {
    if (typeof options === "string") options = { path: options };
    const registry = resolveRegistry(options);
    this.path = registry.path;
    this.managed = registry.managed;
    this.lockTimeoutMs = bounded(options.lockTimeoutMs ?? 1e4, "lockTimeoutMs");
    this.lockRetryMs = bounded(options.lockRetryMs ?? 25, "lockRetryMs");
    this.pythonExecutable = options.pythonExecutable === void 0 ? pythonExecutable(options.env) : nonblank(options.pythonExecutable, "pythonExecutable");
  }
  /** Returns false when this exact row is already registered (idempotent). */
  async add(row, options = {}) {
    const desired = cells(row);
    return this.update((text) => {
      const registry = table(text);
      const matching = registry.rows.filter((line) => parse(line.text)[2] === row.taskName);
      if (matching.length > 0) {
        if (matching.length === 1 && JSON.stringify(parse(matching[0].text)) === JSON.stringify(desired)) return text;
        throw new RegistryError(`Task '${row.taskName}' is already registered by a different owner or duplicated`);
      }
      const prefix = registry.insertion > 0 && !/[\r\n]/.test(text[registry.insertion - 1]) ? registry.newline : "";
      const added = `${prefix}| ${desired.join(" | ")} |${registry.newline}`;
      return text.slice(0, registry.insertion) + added + text.slice(registry.insertion);
    }, options.signal);
  }
  /** Returns false when absent. Never removes a row whose ownership differs. */
  async remove(row, options = {}) {
    const desired = cells(row);
    return this.update((text) => {
      const registry = table(text);
      const matching = registry.rows.filter((line2) => parse(line2.text)[2] === row.taskName);
      if (matching.length === 0) return text;
      if (matching.length !== 1 || JSON.stringify(parse(matching[0].text)) !== JSON.stringify(desired)) {
        throw new RegistryError(`Refusing to remove task '${row.taskName}': ownership does not match`);
      }
      const line = matching[0];
      return text.slice(0, line.start) + text.slice(line.end);
    }, options.signal);
  }
  async update(transform, signal) {
    signal?.throwIfAborted();
    if (this.managed) {
      await mkdir(dirname2(this.path), { recursive: true, mode: 448 });
      const parent = await lstat(dirname2(this.path));
      if (!parent.isDirectory()) throw new RegistryError("Managed registry parent must be a directory, not a symlink");
      if ((parent.mode & 63) !== 0) throw new RegistryError("Managed registry parent must be private (0700); choose a private state directory. Existing directory permissions are not changed automatically.");
    }
    const target = this.managed ? join3(await realpath(dirname2(this.path)), "registry.md") : await realpath(this.path);
    const lock = await this.lock(`${target}${REGISTRY_LOCK_SUFFIX}`, signal);
    const token = randomUUID2();
    let temporary;
    try {
      signal?.throwIfAborted();
      if (this.managed) await this.initialize(target, lock.check);
      const before = await lstat(target);
      if (!before.isFile()) throw new RegistryError("Registry target must be a regular file");
      const original = await readFile(target, "utf8");
      const updated = transform(original);
      if (original === updated) return false;
      temporary = join3(dirname2(target), `.${target.split("/").at(-1)}.${token}.tmp`);
      const handle = await open(temporary, "wx", before.mode & 511);
      try {
        await handle.chmod(before.mode & 511);
        await handle.writeFile(updated, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      const current = await lstat(target);
      if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || await readFile(target, "utf8") !== original) {
        throw new RegistryError("Registry changed outside its lock; retry without overwriting those changes");
      }
      lock.check();
      await rename(temporary, target);
      temporary = void 0;
      const dir = await open(dirname2(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return true;
    } finally {
      try {
        if (temporary) await unlink(temporary).catch((error) => {
          if (!errno(error, "ENOENT")) throw error;
        });
      } finally {
        await lock.release();
      }
    }
  }
  /** Publish a complete initial table without replacing any existing path.
   * Called only under the same cooperative lock used by all row updates. */
  async initialize(target, check) {
    try {
      await lstat(target);
      return;
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
    const temporary = join3(dirname2(target), `.registry.${randomUUID2()}.tmp`);
    const handle = await open(temporary, "wx", 384);
    try {
      try {
        await handle.chmod(384);
        await handle.writeFile(MANAGED_REGISTRY, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      check();
      try {
        await link(temporary, target);
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
      const dir = await open(dirname2(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(temporary);
    }
  }
  async lock(path, signal) {
    signal?.throwIfAborted();
    const child = spawn2(this.pythonExecutable, ["-u", "-c", FLOCK_HELPER, path, String(this.lockTimeoutMs / 1e3), String(this.lockRetryMs / 1e3)], { stdio: ["pipe", "pipe", "pipe"] });
    let closed = false;
    const exit = new Promise((resolveExit) => child.once("close", () => {
      closed = true;
      resolveExit();
    }));
    child.stdin.on("error", () => {
    });
    let failure;
    let acquired = false;
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + String(data)).slice(0, 4096);
    });
    const abort = () => {
      failure = signal?.reason;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new RegistryError(`Timed out waiting for registry lock ${path}`);
      child.kill("SIGTERM");
    }, this.lockTimeoutMs + 1e3);
    try {
      await new Promise((resolveReady, rejectReady) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
          if (output === "locked\n") {
            acquired = true;
            resolveReady();
          } else if (output.length > 100) {
            failure = new RegistryError("Invalid registry lock helper response");
            child.kill("SIGTERM");
          }
        });
        child.once("error", (error) => {
          failure = new RegistryError("Cannot start Python flock helper", { cause: error });
        });
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
    const check = () => {
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new RegistryError("Registry lock helper died during update; lock ownership was lost");
    };
    return { check, release: async () => {
      check();
      child.stdin.end();
      await exit;
    } };
  }
};

// src/doctor.ts
async function installationReport(options = {}) {
  const checks = [];
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e) });
    }
  };
  const environment = selectedEnvironment();
  const run = options.run ?? command;
  const assets = options.assetsDir ?? fileURLToPath(new URL("../dist/", import.meta.url));
  await check("node", async () => {
    if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Install Node.js 22 or newer.");
    return process.versions.node;
  });
  await check("host", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("The supported local Tart/vm-service backend requires an Apple-silicon Mac. Ubuntu is a guest, not a substitute host.");
    return `${process.platform}/${process.arch}`;
  });
  await check("python", async () => {
    const r = await run([pythonExecutable(), "-c", "import fcntl, sys; print(sys.version.split()[0])"], { timeoutMs: 5e3 });
    if (r.code !== 0) throw Error("Install Python 3 with fcntl, or set MCP_RELAY_PYTHON to its executable. " + r.stderr);
    return r.stdout.trim();
  });
  await check("runtime-bundles", async () => {
    const integrity = JSON.parse(await readFile2(join4(assets, "integrity.json"), "utf8"));
    for (const name of ["server.mjs", "receiver.mjs", "doctor.mjs"]) {
      const b = await readFile2(join4(assets, name));
      if (hash(b) !== integrity[name]) throw Error(`Invalid/missing shipped ${name}; reinstall the package.`);
    }
    return "Host extension, guest receiver and doctor hashes verified";
  });
  await check("registry", async () => {
    const registry = options.registry ?? new Registry(environment ? { managedRoot: environment.profile.relayStateDir } : {});
    try {
      await access(registry.path);
      validateRegistryText(await readFile2(registry.path, "utf8"));
      return `Existing registry: ${registry.path}`;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (process.env.MCP_RELAY_REGISTRY) throw Error("MCP_RELAY_REGISTRY must point to an existing Using VMs registry table.");
      return `Managed registry will be created on first acquisition: ${registry.path}`;
    }
  });
  await check("tart", async () => {
    const r = await run([environment?.profile.tartPath ?? "tart", "list", "--format", "json"], { timeoutMs: 1e4, ...environment ? { env: { ...process.env, ...environmentVariables(environment) } } : {} });
    if (r.code !== 0 || !Array.isArray(JSON.parse(r.stdout))) throw Error("Install Tart and ensure tart list --format json works; required for independent destruction verification.");
    return "Read-only local inventory available";
  });
  await check("vm-service", async () => {
    const vm = options.vm ?? new VmService({ baseUrl: environment?.profile.vmServiceUrl ?? process.env.MCP_RELAY_URL, environment });
    const health = await vm.health({ timeoutMs: 5e3 });
    if (!health.ok) throw Error("Service health check failed");
    if (environment && !matchesEnvironment(health.environment, environment)) throw Error("VM service environment identity mismatch");
    const images = await vm.images({ timeoutMs: 5e3 });
    await vm.list({ timeoutMs: 5e3 });
    const available = Object.entries(images.images).filter(([, v]) => v.base_available).map(([k]) => k);
    if (!available.length) throw Error("vm-service is running but has no available golden images. Provision a supported image in the backend.");
    return `HTTP API reachable; available images: ${available.join(", ")}. This inventory does not prove guest readiness. Use relay probe scope=guest for executable checks; capture and browser behavior require separate checks. Staging alone is not readiness.`;
  });
  return { formatVersion: 1, ready: checks.every((c) => c.ok), environment: environment?.identity, stateDirectory: environment?.profile.relayStateDir ?? relayStateRoot(), checks, note: "Read-only host/API prerequisite check. No VM acquired, input sent, screenshot captured or permissions changed. Claude Code (or another MCP client) must be installed separately." };
}
if (process.argv[1] && pathToFileURL(realpathSync2(process.argv[1])).href === import.meta.url) {
  try {
    const r = await installationReport();
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ready ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ready: false, error: String(e), hint: "Check MCP_RELAY_* configuration and installation paths." }, null, 2));
    process.exitCode = 1;
  }
}
export {
  installationReport
};
