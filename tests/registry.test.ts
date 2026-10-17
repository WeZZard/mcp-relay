import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { pythonExecutable } from "../src/config.js";
import { Registry, RegistryError, resolveRegistry, validateRegistryText, type RegistryRow } from "../src/registry.js";

const fixture = `# Personal instructions

## Using Remote Computers

**Task Registry:**

| Machine | OS | Task Name | Agent | Project | Start Date |
| ------- | -- | --------- | ----- | ------- | ---------- |
| remote | macOS | remote-task | Someone | /elsewhere | yesterday |

## Using VMs

Keep all instructions unchanged.

**Task Registry:**

| Machine | OS | Task Name | Agent | Project | Start Date |
| ------- | -- | --------- | ----- | ------- | ---------- |
| <IP-address> | <os> | <task-name> | <who-you-are> | <project-path> | <YYYY-MM-DD-hh-mm-ss-Z> |
| existing-vm | Linux | existing-task | Someone | /project | yesterday |

---

## Walkthrough Your Work

Do not change me.
`;
const row: RegistryRow = { machine: "pilot-test-123", os: "Ubuntu 24.04", taskName: "our-task", agent: "pi-test", project: "/our/project", startDate: "2026-09-13-10-00-00-Z" };
async function setup(t: test.TestContext, contents = fixture) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-relay-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "AGENTS.md");
  await writeFile(path, contents);
  return { dir, path, registry: new Registry(path) };
}

test("add/remove are idempotent; preserve every byte outside owned row", async t => {
  const { path, registry, dir } = await setup(t);
  await chmod(path, 0o640);
  assert.equal(await registry.add(row), true);
  const text = await readFile(path, "utf8");
  const line = "| pilot-test-123 | Ubuntu 24.04 | our-task | pi-test | /our/project | 2026-09-13-10-00-00-Z |\n";
  assert.equal(text.replace(line, ""), fixture);
  assert(text.indexOf(line) > text.indexOf("## Using VMs"));
  assert.equal((await lstat(path)).mode & 0o777, 0o640);
  assert.equal(await registry.add(row), false);
  assert.equal(await registry.remove(row), true);
  assert.equal(await registry.remove(row), false);
  assert.equal(await readFile(path, "utf8"), fixture);
  assert.deepEqual((await readdir(dir)).sort(), ["AGENTS.md", "AGENTS.md.mcp-vm-relay.lock"]);
});

test("cannot overwrite or remove another owner's row", async t => {
  const { path, registry } = await setup(t);
  await registry.add(row);
  const before = await readFile(path, "utf8");
  for (const key of ["machine", "os", "agent", "project", "startDate"] as const) {
    const impostor = { ...row, [key]: "different" };
    await assert.rejects(registry.remove(impostor), /ownership/);
    await assert.rejects(registry.add(impostor), /different owner/);
  }
  assert.equal(await readFile(path, "utf8"), before);
});

test("preserves CRLF and symlink target; rejects malformed structure and row injection", async t => {
  const { path, dir, registry } = await setup(t, fixture.replaceAll("\n", "\r\n"));
  const link = join(dir, "CLAUDE.md");
  await symlink(path, link);
  await new Registry(link).add(row);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert(!(await readFile(path, "utf8")).replaceAll("\r\n", "").includes("\n"));
  await registry.remove(row);
  assert.equal(await readFile(path, "utf8"), fixture.replaceAll("\n", "\r\n"));
  await assert.rejects(registry.add({ ...row, agent: "bad|cell" }), RegistryError);
  await assert.rejects(registry.add({ ...row, taskName: "bad\nrow" }), RegistryError);
  await writeFile(path, fixture.replace("## Using VMs", "## Wrong section"));
  await assert.rejects(registry.add(row), /exactly one/);
  await writeFile(path, fixture.replace("| existing-vm | Linux |", "| malformed |"));
  await assert.rejects(registry.add(row), /Malformed/);
});

test("concurrent processes serialize updates without lost rows", async t => {
  const { path } = await setup(t);
  const modulePath = fileURLToPath(new URL("../src/registry.ts", import.meta.url));
  const children = Array.from({ length: 10 }, (_, i) => {
    const current = { ...row, taskName: `parallel-${i}`, machine: `vm-${i}` };
    const script = `import { Registry } from ${JSON.stringify(modulePath)}; await new Registry(${JSON.stringify(path)}).add(${JSON.stringify(current)});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    return once(child, "close").then(([code]) => assert.equal(code, 0, stderr));
  });
  await Promise.all(children);
  const text = await readFile(path, "utf8");
  for (let i = 0; i < 10; i++) assert.equal(text.split(`| parallel-${i} |`).length, 2);
  assert.equal(text.split("\n").filter(line => !/\| parallel-\d+ \|/.test(line)).join("\n"), fixture);
});

async function holdLock(path: string) {
  const child = spawn(pythonExecutable(), ["-u", "-c", "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", `${path}.mcp-vm-relay.lock`], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  return child;
}

test("live lock times out; killed lock owner is recoverable immediately", async t => {
  const { path } = await setup(t);
  const child = await holdLock(path);
  t.after(() => { child.kill("SIGKILL"); });
  const registry = new Registry({ path, lockTimeoutMs: 50, lockRetryMs: 5 });
  await assert.rejects(registry.add(row), /lock timeout|Timed out/);
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  assert.equal(await registry.add(row), true);
});

test("cancellation while waiting releases helper; pre-abort does not edit", async t => {
  const { path } = await setup(t);
  const child = await holdLock(path);
  t.after(() => { child.kill("SIGKILL"); });
  const registry = new Registry({ path, lockTimeoutMs: 2000 });
  const controller = new AbortController();
  const pending = registry.add(row, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancel waiting")), 30);
  await assert.rejects(pending, /cancel waiting/);
  await assert.rejects(registry.add(row, { signal: controller.signal }), /cancel waiting/);
  assert.equal(await readFile(path, "utf8"), fixture);
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  assert.equal(await registry.add(row), true);
});

test("killed Node owner closes helper pipe and releases its kernel lock", async t => {
  const { path } = await setup(t);
  const modulePath = fileURLToPath(new URL("../src/registry.ts", import.meta.url));
  // Exercise the private lock primitive to pause deterministically inside a critical section.
  const script = `import { Registry } from ${JSON.stringify(modulePath)}; await new Registry(${JSON.stringify(path)}).lock(${JSON.stringify(`${path}.mcp-vm-relay.lock`)}); console.log('held'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  assert.equal(await new Registry({ path, lockTimeoutMs: 1000 }).add(row), true);
});

test("read-only validation uses the exact VM table parser", () => {
  assert.equal(validateRegistryText(fixture), undefined);
  assert.throws(() => validateRegistryText(fixture.replace("## Using VMs", "## Different")), /exactly one/);
  assert.throws(() => validateRegistryText(fixture.replace("| existing-vm | Linux |", "| malformed |")), /Malformed/);
});

test("selection preserves compatible home registry and otherwise uses managed state lazily", async t => {
  const { dir, path } = await setup(t);
  const env = {};
  assert.deepEqual(resolveRegistry({ home: dir, env }), { path, managed: false });
  const compatible = new Registry({ home: dir, env });
  await compatible.add(row);
  await compatible.remove(row);
  assert.equal(await readFile(path, "utf8"), fixture);
  const incompatible = fixture.replace("## Using VMs", "## Not VMs");
  await writeFile(path, incompatible);
  const state = join(dir, ".local/state/mcp-relay");
  const registry = new Registry({ home: dir, env });
  assert.equal(registry.path, join(state, "registry.md"));
  await assert.rejects(lstat(state), /ENOENT/);
  await registry.add(row);
  assert.equal(await readFile(path, "utf8"), incompatible);
  assert.equal((await lstat(state)).mode & 0o777, 0o700);
  assert.equal((await lstat(registry.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(`${registry.path}.mcp-vm-relay.lock`)).mode & 0o777, 0o600);
  await registry.remove(row);
});

test("explicit path beats environment; missing and incompatible explicit documents never get created or repaired", async t => {
  const { dir, path } = await setup(t);
  const missing = join(dir, "missing.md");
  assert.equal(new Registry({ path, env: { MCP_RELAY_REGISTRY: missing } }).path, path);
  assert.equal(new Registry({ home: dir, env: { MCP_RELAY_REGISTRY: path } }).path, path);
  for (const options of [{ path: missing }, { env: { MCP_RELAY_REGISTRY: missing } }]) {
    assert.throws(() => new Registry({ home: dir, ...options }), /ENOENT/);
  }
  await assert.rejects(lstat(missing), /ENOENT/);
  await assert.rejects(lstat(`${missing}.mcp-vm-relay.lock`), /ENOENT/);
  await writeFile(path, "keep me");
  assert.throws(() => new Registry({ path }), /exactly one/);
  assert.throws(() => new Registry({ env: { MCP_RELAY_REGISTRY: path } }), /exactly one/);
  assert.equal(await readFile(path, "utf8"), "keep me");
  for (const options of [{ path: " " }, { env: { MCP_RELAY_REGISTRY: "" } }]) {
    assert.throws(() => new Registry({ home: dir, ...options }), /nonblank/);
  }
});

test("managed initialization never truncates an existing incompatible file or follows a file symlink", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-managed-existing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { home: dir, env: { MCP_RELAY_STATE_DIR: join(dir, "state") } };
  const registry = new Registry(options);
  await mkdir(join(dir, "state"), {mode:0o700});
  await writeFile(registry.path, "not a registry");
  await assert.rejects(registry.add(row), /exactly one/);
  assert.equal(await readFile(registry.path, "utf8"), "not a registry");
  await rm(registry.path);
  const foreign = join(dir, "foreign.md");
  await writeFile(foreign, fixture);
  await symlink(foreign, registry.path);
  await assert.rejects(registry.add(row), /regular file/);
  assert.equal(await readFile(foreign, "utf8"), fixture);
});

test('managed state never chmods an existing public directory', async t => {
  const dir=await mkdtemp(join(tmpdir(),'relay-public-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await chmod(dir,0o755);
  const registry=new Registry({home:dir,env:{MCP_RELAY_STATE_DIR:dir}});
  await assert.rejects(registry.add(row),/private/);
  assert.equal((await lstat(dir)).mode&0o777,0o755);
  assert.deepEqual(await readdir(dir),[]);
});

test("concurrent fresh default initialization is atomic, private, and supports later add/remove", { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-managed-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  delete env.MCP_RELAY_STATE_DIR;
  delete env.XDG_STATE_HOME;
  delete env.MCP_RELAY_REGISTRY;
  delete env.MCP_RELAY_PYTHON;
  const modulePath = fileURLToPath(new URL("../src/registry.ts", import.meta.url));
  await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const current = { ...row, taskName: `fresh-${i}` };
    const script = `import { Registry } from ${JSON.stringify(modulePath)}; await new Registry().add(${JSON.stringify(current)});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    assert.equal((await once(child, "close"))[0], 0, stderr);
  }));
  const registry = new Registry({ env, home: dir });
  const text = await readFile(registry.path, "utf8");
  assert.equal(text.split("## Using VMs").length, 2);
  for (let i = 0; i < 10; i++) assert.equal(text.split(`| fresh-${i} |`).length, 2);
  const state = join(dir, ".local/state/mcp-relay");
  assert.equal((await lstat(state)).mode & 0o777, 0o700);
  assert.equal((await lstat(registry.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(`${registry.path}.mcp-vm-relay.lock`)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(state)).sort(), ["registry.md", "registry.md.mcp-vm-relay.lock"]);
  await assert.rejects(lstat(join(dir, "AGENTS.md")), /ENOENT/);
  assert.equal(await registry.add(row), true);
  assert.equal(await registry.remove(row), true);
  assert.equal(await readFile(registry.path, "utf8"), text);
  for (let i = 0; i < 10; i++) assert.equal(await registry.remove({ ...row, taskName: `fresh-${i}` }), true);
});

test("registry rejects blank Python overrides and uses environment override", async t => {
  const { path } = await setup(t);
  for (const value of ["", " \t"]) {
    assert.throws(() => new Registry({ path, pythonExecutable: value }), /nonblank/);
    assert.throws(() => new Registry({ path, env: { MCP_RELAY_PYTHON: value } }), /nonblank/);
  }
  await assert.rejects(new Registry({ path, env: { MCP_RELAY_PYTHON: "/no/such/python" } }).add(row), /Cannot start/);
  assert.equal(await readFile(path, "utf8"), fixture);
});

test("missing Python helper fails bounded and leaves registry untouched", async t => {
  const { path } = await setup(t);
  await assert.rejects(new Registry({ path, pythonExecutable: "/no/such/python" }).add(row), /Cannot start/);
  assert.equal(await readFile(path, "utf8"), fixture);
});
