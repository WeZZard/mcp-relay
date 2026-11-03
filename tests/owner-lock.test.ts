import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { childEnvironment } from "./isolation.js";

const modulePath = fileURLToPath(new URL("../src/owner-lock.ts", import.meta.url));
const workerScript = `
import { acquireOwnerLock } from ${JSON.stringify(modulePath)};
process.send('ready');
process.once('message', async () => {
  try {
    const lock = await acquireOwnerLock(process.env.LOCK_PATH, { timeoutMs: 5000 });
    process.send('held');
    process.once('message', async () => { await lock.release(); process.exit(0); });
  } catch (error) { process.send(String(error)); process.exit(2); }
});
`;
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-owner-lock-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }));
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "owner.lock");
  async function worker() {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerScript], {
      env: childEnvironment({ LOCK_PATH: path }), stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const exited = once(child, "exit");
    const first = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(() => { throw new Error(`Worker exited before ready: ${stderr}`); }),
    ]);
    assert.equal(first, "ready");
    return {
      child, exited,
      async acquire() {
        const result = once(child, "message");
        child.send("go");
        return (await result)[0] as string;
      },
      async release() { child.send("release"); assert.equal((await exited)[0], 0, stderr); },
      async kill() { child.kill("SIGKILL"); await exited; },
    };
  }
  return { dir, path, worker };
}

const bounds = { timeout: 20_000 };
test("cross-process owners fail fast; release is idempotent and preserves the inode", bounds, async t => {
  const { path, worker } = await setup(t);
  const owner = await acquireOwnerLock(path);
  t.after(() => owner.release());
  const before = await lstat(path);
  const contender = await worker();
  assert.match(await contender.acquire(), /Another relay manager owns/);
  assert.equal((await contender.exited)[0], 2);
  await Promise.all([owner.release(), owner.release()]);
  const replacement = await worker();
  assert.equal(await replacement.acquire(), "held");
  await replacement.release();
  assert.equal((await lstat(path)).ino, before.ino);
  assert.equal(await readFile(path, "utf8"), "");
  assert.equal(before.mode & 0o777, 0o600);
});

test("killed Node owner releases through EOF without PID metadata or unlink", bounds, async t => {
  const { path, worker } = await setup(t);
  const original = await worker();
  assert.equal(await original.acquire(), "held");
  const before = await lstat(path);
  // Zero bytes also models a crash before any optional metadata write.
  assert.equal(before.size, 0);
  await original.kill();
  const replacement = await worker();
  assert.equal(await replacement.acquire(), "held");
  await replacement.release();
  assert.equal((await lstat(path)).ino, before.ino);
});

for (const recover of [false, true]) test(`simultaneous ${recover ? "recovery after killed owner" : "first acquisition"} admits exactly one owner`, bounds, async t => {
  const { path, worker } = await setup(t);
  const owner = recover ? await worker() : undefined;
  if (owner) assert.equal(await owner.acquire(), "held");
  else await assert.rejects(lstat(path), /ENOENT/);
  const contenders = await Promise.all(Array.from({ length: 8 }, () => worker()));
  await owner?.kill();
  const results = await Promise.all(contenders.map(contender => contender.acquire()));
  assert.equal(results.filter(result => result === "held").length, 1, JSON.stringify(results));
  for (let i = 0; i < results.length; i++) {
    if (results[i] === "held") await contenders[i]!.release();
    else {
      assert.match(results[i]!, /Another relay manager owns/);
      assert.equal((await contenders[i]!.exited)[0], 2);
    }
  }
});

test("missing helper and helper exit before announcement reject within a bound", bounds, async t => {
  const { path } = await setup(t);
  await assert.rejects(acquireOwnerLock(path, { pythonExecutable: "/no/such/python", timeoutMs: 100 }), /Cannot start/);
  await assert.rejects(acquireOwnerLock(path, { pythonExecutable: "/usr/bin/true", timeoutMs: 100 }), /before announcement/);
  const lock = await acquireOwnerLock(path);
  await lock.release();
});

test("a helper that exits at once still reports its whole reason", bounds, async t => {
  const { dir, path } = await setup(t);
  // A shell stand-in for Python: it ignores the -u -c arguments, writes the
  // reason and exits. Exit can be observed before stderr is read, so the error
  // must be built once the streams have closed.
  const quick = join(dir, "quick-helper");
  await writeFile(quick, "#!/bin/sh\nprintf 'Another relay manager owns this session' >&2\nexit 2\n");
  await chmod(quick, 0o700);
  for (let i = 0; i < 30; i++) {
    await assert.rejects(acquireOwnerLock(path, { pythonExecutable: quick, timeoutMs: 5000 }), /before announcement: Another relay manager owns this session/);
  }
});

async function helper(dir: string, body: string) {
  const path = join(dir, "helper.py");
  await writeFile(path, `#!/usr/bin/python3\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

test("hung helper times out; cancellation kills it and closes parent descriptor", bounds, async t => {
  const { dir, path } = await setup(t);
  const pythonExecutable = await helper(dir, "import fcntl, time\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\ntime.sleep(60)");
  await assert.rejects(acquireOwnerLock(path, { pythonExecutable, timeoutMs: 100 }), /Timed out/);
  const controller = new AbortController();
  const pending = acquireOwnerLock(path, { pythonExecutable, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error("cancel acquire")), 100);
  try { await assert.rejects(pending, /cancel acquire/); } finally { clearTimeout(timer); }
  await assert.rejects(acquireOwnerLock(path, { signal: controller.signal }), /cancel acquire/);
  const lock = await acquireOwnerLock(path);
  await lock.release();
});

test("cancellation after acquisition never silently relinquishes ownership", bounds, async t => {
  const { path } = await setup(t);
  const controller = new AbortController();
  const lock = await acquireOwnerLock(path, { signal: controller.signal });
  t.after(() => lock.release());
  controller.abort();
  await assert.rejects(acquireOwnerLock(path), /Another relay manager owns/);
  await lock.release();
});

test("helper death after announcement cannot unlock the live parent's descriptor", bounds, async t => {
  const { dir, path, worker } = await setup(t);
  const marker = join(dir, "exiting");
  const pythonExecutable = await helper(dir, `import fcntl, sys, time, os
fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
print('locked', flush=True)
time.sleep(0.1)
with open(${JSON.stringify(marker)}, 'w') as marker:
    marker.write(str(os.getpid()))
os._exit(0)`);
  // This case verifies descriptor ownership after helper death, not startup speed.
  // Fresh executable fixtures can approach the production two-second deadline.
  const lock = await acquireOwnerLock(path, { pythonExecutable, timeoutMs: 5000 });
  t.after(() => lock.release());
  // Observe actual helper death before testing the kernel lock. PID probing is
  // solely a test synchronization assertion, never an ownership credential.
  const contender = await worker();
  for (let i = 0; ; i++) {
    let dead = false;
    try {
      const pid = Number(await readFile(marker, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          dead = true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dead) break;
    assert(i < 100, "helper did not exit");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(await contender.acquire(), /Another relay manager owns/);
  await contender.exited;
  await lock.release();
  const replacement = await acquireOwnerLock(path);
  await replacement.release();
});

test("helper crashes after flock but before announcing: no orphan lock remains", bounds, async t => {
  const { dir, path } = await setup(t);
  const pythonExecutable = await helper(dir, "import fcntl, os\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nos._exit(7)");
  await assert.rejects(acquireOwnerLock(path, { pythonExecutable, timeoutMs: 5000 }), /before announcement/);
  const lock = await acquireOwnerLock(path);
  await lock.release();
});

test("legacy directories and symlinks fail closed; stale metadata is not authority", bounds, async t => {
  const { dir, path } = await setup(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), "999999999");
  await assert.rejects(acquireOwnerLock(path), /EISDIR|regular file/);
  assert.equal(await readFile(join(path, "pid"), "utf8"), "999999999");
  const regular = join(dir, "regular.lock");
  await writeFile(regular, String(process.pid));
  const link = join(dir, "symlink.lock");
  await symlink(regular, link);
  await assert.rejects(acquireOwnerLock(link), /ELOOP/);
  const lock = await acquireOwnerLock(regular);
  await lock.release();
  assert.equal(await readFile(regular, "utf8"), String(process.pid));
});

test("invalid acquisition bounds reject before touching disk", bounds, async t => {
  const { path } = await setup(t);
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    await assert.rejects(acquireOwnerLock(path, { timeoutMs }), /positive bounded integer/);
  }
  await assert.rejects(lstat(path), /ENOENT/);
});
