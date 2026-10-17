import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { guestNetwork, pythonExecutable, registryDiagnosticsPath, relayStateRoot } from "../src/config.js";
import { acquireOwnerLock } from "../src/owner-lock.js";

const home = join(tmpdir(), "relay-config-home");
test("state root precedence is portable and does not read or create state", () => {
  assert.equal(relayStateRoot({ env: {}, home }), join(home, ".local/state/mcp-relay"));
  assert.equal(relayStateRoot({ env: { HOME: home } }), join(home, ".local/state/mcp-relay"));
  assert.equal(relayStateRoot({ env: { XDG_STATE_HOME: "/state" }, home }), "/state/mcp-relay");
  assert.equal(relayStateRoot({ env: { MCP_RELAY_STATE_DIR: "/custom/relay", XDG_STATE_HOME: "ignored" }, home }), "/custom/relay");
  assert.equal(registryDiagnosticsPath({ env: {}, home }), join(home, ".local/state/mcp-relay/registry.md"));
  assert.equal(registryDiagnosticsPath({ env: { MCP_RELAY_REGISTRY: "/missing/user.md" }, home }), "/missing/user.md");
});

test("configured roots reject relative, empty, blank, and NUL values", () => {
  for (const value of ["relative", "", " \t ", "~/state", "/bad\0path"]) {
    for (const key of ["MCP_RELAY_STATE_DIR", "XDG_STATE_HOME"]) {
      assert.throws(() => relayStateRoot({ env: { [key]: value }, home }), /absolute|nonblank/);
    }
  }
  assert.throws(() => relayStateRoot({ env: {}, home: "relative" }), /absolute/);
  for (const value of [' ', 'relative/registry.md']) assert.throws(() => registryDiagnosticsPath({ env: { MCP_RELAY_REGISTRY: value } }), /nonblank|absolute/);
});

test("Python uses PATH by default and rejects empty overrides", () => {
  assert.equal(pythonExecutable({}), "python3");
  assert.equal(pythonExecutable({ MCP_RELAY_PYTHON: "/custom/python" }), "/custom/python");
  assert.equal(pythonExecutable({ MCP_RELAY_PYTHON: "python-custom" }), "python-custom");
  for (const value of ["", " \t", "bad\0exe"]) assert.throws(() => pythonExecutable({ MCP_RELAY_PYTHON: value }), /nonblank/);
});

test("owner lock rejects explicit blank executable before creating its file", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-config-owner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const value of ["", " \t"]) {
    await assert.rejects(acquireOwnerLock(join(dir, "owner.lock"), { pythonExecutable: value }), /nonblank/);
  }
  assert.deepEqual(await readdir(dir), []);
});

test("owner lock honors environment Python override without touching global state", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-config-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = fileURLToPath(new URL("../src/owner-lock.ts", import.meta.url));
  for (const executable of ["", "/no/such/python"]) {
    const script = `import assert from 'node:assert/strict'; import { acquireOwnerLock } from ${JSON.stringify(modulePath)}; await assert.rejects(acquireOwnerLock(${JSON.stringify(join(dir, "owner.lock"))}), /${executable ? "Cannot start" : "nonblank"}/);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, HOME: dir, MCP_RELAY_PYTHON: executable }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    assert.equal((await once(child, "close"))[0], 0, stderr);
  }
});

test("the guest network is nat unless MCP_RELAY_GUEST_NETWORK names internet; anything else is refused (DC-17)", () => {
  assert.equal(guestNetwork({}), "nat");
  assert.equal(guestNetwork({ MCP_RELAY_GUEST_NETWORK: "nat" }), "nat");
  assert.equal(guestNetwork({ MCP_RELAY_GUEST_NETWORK: "internet" }), "internet");
  for (const value of ["", "host", "Internet", "nat,internet", "bridged"]) assert.throws(() => guestNetwork({ MCP_RELAY_GUEST_NETWORK: value }), /MCP_RELAY_GUEST_NETWORK must be nat or internet/, value);
});

test("the variables of the project's earlier name, MCP_VM_RELAY_*, are not read (DC-16)", () => {
  const env = { MCP_VM_RELAY_STATE_DIR: "/old/state", MCP_VM_RELAY_REGISTRY: "/old/registry.md", MCP_VM_RELAY_PYTHON: "/old/python" };
  assert.equal(relayStateRoot({ env, home }), join(home, ".local/state/mcp-relay"));
  assert.equal(registryDiagnosticsPath({ env, home }), join(home, ".local/state/mcp-relay/registry.md"));
  assert.equal(pythonExecutable(env), "python3");
});
