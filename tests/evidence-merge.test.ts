import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshEvidenceState } from "../src/evidence-merge.js";
import { childEnvironment } from './isolation.js';

async function save(root: string, path: string, data: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), data);
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "relay-state-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const incoming = join(root, "incoming"), destination = join(root, "package/state"), archive = join(root, "package.finalization-attempts");
  await mkdir(incoming);
  const refresh = () => refreshEvidenceState(incoming, destination, archive);
  return { root, incoming, destination, archive, refresh };
}
/** refreshEvidenceState with an injected rename, to exercise the cross-volume copy path. */
const refreshWith = refreshEvidenceState as (incoming: string, destination: string, archiveRoot: string, options: { rename: (from: string, to: string) => Promise<void> }) => Promise<void>;
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("refresh creates state without making an unnecessary archive", async t => {
  const f = await fixture(t);
  await save(f.incoming, "snapshots/session/before.png", "original");
  await save(f.incoming, "journal/events.jsonl", "journal");
  await mkdir(join(f.incoming, "empty"));
  await f.refresh();
  assert.equal(await readFile(join(f.destination, "snapshots/session/before.png"), "utf8"), "original");
  assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "journal");
  assert.ok((await lstat(join(f.destination, "empty"))).isDirectory());
  await absent(f.archive);
});

test("refresh moves incoming into state on the same volume instead of copying it, so the state is not stored twice", async t => {
  const f = await fixture(t);
  await save(f.incoming, "snapshots/session/before.png", "original");
  await save(f.incoming, "journal/events.jsonl", "journal");
  const inode = (await lstat(join(f.incoming, "snapshots/session/before.png"))).ino;
  await f.refresh();
  assert.equal((await lstat(join(f.destination, "snapshots/session/before.png"))).ino, inode, "the delivered snapshot is the pulled file, not a copy");
  assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "journal");
  await absent(f.incoming);
});

test("refresh falls back to copying when incoming is on another volume, and keeps incoming", async t => {
  const f = await fixture(t);
  await save(f.destination, "snapshots/session/original.png", "retained");
  await save(f.incoming, "snapshots/session/before.png", "original");
  await save(f.incoming, "journal/events.jsonl", "journal");
  const renames: string[] = [];
  await refreshWith(f.incoming, f.destination, f.archive, { rename: async (from, to) => {
    if (from === f.incoming) { renames.push(from); throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); }
    await rename(from, to);
  } });
  assert.equal(await readFile(join(f.destination, "snapshots/session/before.png"), "utf8"), "original");
  assert.equal(await readFile(join(f.destination, "snapshots/session/original.png"), "utf8"), "retained");
  assert.deepEqual(renames, [f.incoming], "the move is tried first");
  assert.equal(await readFile(join(f.incoming, "journal/events.jsonl"), "utf8"), "journal", "a copy keeps its source");
});

test("equal snapshots are allowed, mutable records refresh, and every previous attempt is archived", async t => {
  const f = await fixture(t);
  await save(f.destination, "snapshots/session/before.png", "original");
  await save(f.destination, "journal/events.jsonl", "old journal");
  await save(f.destination, "records/actions/a.json", "old action");
  await save(f.incoming, "snapshots/session/before.png", "original");
  await save(f.incoming, "snapshots/session/after.png", "after");
  await save(f.incoming, "journal/events.jsonl", "new journal");
  await save(f.incoming, "records/actions/a.json", "new action");
  const inode = (await lstat(join(f.destination, "snapshots/session/before.png"))).ino;
  await f.refresh();
  const attempts = await readdir(f.archive);
  assert.equal(attempts.length, 1);
  const archived = join(f.archive, attempts[0]!, "state");
  assert.equal((await lstat(join(archived, "snapshots/session/before.png"))).ino, inode);
  assert.equal(await readFile(join(archived, "journal/events.jsonl"), "utf8"), "old journal");
  assert.equal(await readFile(join(archived, "records/actions/a.json"), "utf8"), "old action");
  assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "new journal");
  assert.equal(await readFile(join(f.destination, "records/actions/a.json"), "utf8"), "new action");
  await save(f.incoming, "journal/events.jsonl", "newer journal");
  await f.refresh();
  assert.equal((await readdir(f.archive)).length, 2);
  assert.equal(await readFile(join(archived, "journal/events.jsonl"), "utf8"), "old journal");
});

test("snapshots omitted from incoming survive, while omitted mutable records remain only in the archive", async t => {
  const f = await fixture(t);
  await save(f.destination, "snapshots/session/original.png", "retained");
  await save(f.destination, "records/old.json", "old record");
  await save(f.incoming, "journal/events.jsonl", "new journal");
  await f.refresh();
  assert.equal(await readFile(join(f.destination, "snapshots/session/original.png"), "utf8"), "retained");
  await absent(join(f.destination, "records/old.json"));
  const [attempt] = await readdir(f.archive);
  assert.equal(await readFile(join(f.archive, attempt!, "state/records/old.json"), "utf8"), "old record");
});

for (const conflict of ["bytes", "file-to-directory", "directory-to-file"] as const) {
  test(`snapshot ${conflict} conflict leaves all trees untouched`, async t => {
    const f = await fixture(t);
    await save(f.destination, "journal/events.jsonl", "old journal");
    await save(f.incoming, "journal/events.jsonl", "new journal");
    const path = "snapshots/session/a.png";
    await save(f.destination, conflict === "directory-to-file" ? `${path}/child` : path, "old");
    await save(f.incoming, conflict === "file-to-directory" ? `${path}/child` : path, "new");
    await assert.rejects(f.refresh(), /snapshot conflict/);
    assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "old journal");
    assert.equal(await readFile(join(f.incoming, "journal/events.jsonl"), "utf8"), "new journal");
    await absent(f.archive);
  });
}

for (const location of ["incoming", "destination"] as const) {
  for (const kind of ["symlink", "directory-symlink", "hardlink", "fifo", "unsafe-name"] as const) {
    test(`rejects ${location} ${kind} before archiving`, async t => {
      const f = await fixture(t);
      await mkdir(f.destination, { recursive: true });
      await save(f.destination, "journal/events.jsonl", "prior");
      await save(f.incoming, "journal/events.jsonl", "fresh");
      const target = join(f[location], "bad");
      await save(f.root, "outside/original", "outside");
      if (kind === "symlink") await symlink(join(f.root, "outside/original"), target);
      if (kind === "directory-symlink") await symlink(join(f.root, "outside"), target);
      if (kind === "hardlink") await link(join(f.root, "outside/original"), target);
      if (kind === "fifo") execFileSync("mkfifo", [target], { env: childEnvironment() });
      if (kind === "unsafe-name") await save(f[location], "bad\\name", "unsafe");
      await assert.rejects(f.refresh(), /symlink|non-regular|unsafe/);
      assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "prior");
      assert.equal(await readFile(join(f.root, "outside/original"), "utf8"), "outside");
      await absent(f.archive);
    });
  }
}

for (const location of ["incoming", "destination", "archive"] as const) {
  test(`rejects a symlink at ${location} root`, async t => {
    const f = await fixture(t);
    await mkdir(dirname(f.destination), { recursive: true });
    await mkdir(join(f.root, "outside"));
    if (location === "incoming") await rm(f.incoming, { recursive: true });
    await symlink(join(f.root, "outside"), f[location]);
    await assert.rejects(f.refresh(), /unsafe evidence directory/);
    assert.deepEqual(await readdir(join(f.root, "outside")), []);
  });
}

test("rejects symlink ancestors and traversal in supplied roots", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "outside"));
  await symlink(join(f.root, "outside"), join(f.root, "alias"));
  await assert.rejects(refreshEvidenceState(f.incoming, join(f.root, "alias/state"), f.archive), /unsafe evidence directory/);
  await assert.rejects(refreshEvidenceState(f.incoming, `${f.root}/outside/../state`, f.archive), /unsafe evidence path/);
  await absent(f.archive);
});

test("rejects overlapping source, destination, and archive roots", async t => {
  const f = await fixture(t);
  for (const roots of [
    [f.incoming, f.incoming, f.archive],
    [f.incoming, join(f.incoming, "state"), f.archive],
    [f.incoming, f.destination, join(f.destination, "archive")],
    [f.incoming, f.destination, f.root],
  ]) await assert.rejects(refreshEvidenceState(roots[0]!, roots[1]!, roots[2]!), /overlapping evidence roots/);
  assert.deepEqual(await readdir(f.incoming), []);
});

test("refuses sealed packages before moving state, even when manifest is malformed", async t => {
  const f = await fixture(t);
  await save(f.destination, "journal/events.jsonl", "sealed state");
  await save(dirname(f.destination), "manifest.json", "not parsed");
  await assert.rejects(f.refresh(), /sealed evidence package/);
  assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "sealed state");
  await absent(f.archive);
});

test("copy failure retains the archived original state and incoming staging for recovery", { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  await save(f.destination, "journal/events.jsonl", "prior journal");
  await save(f.destination, "snapshots/session/original.png", "prior snapshot");
  await save(f.incoming, "journal/events.jsonl", "fresh journal");
  const source = join(f.incoming, "journal/events.jsonl");
  await chmod(source, 0o000);
  // The copy path runs when incoming is on another volume than the state.
  const crossVolume = async (from: string, to: string) => {
    if (from === f.incoming) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    await rename(from, to);
  };
  try {
    await assert.rejects(refreshWith(f.incoming, f.destination, f.archive, { rename: crossVolume }), { code: "EACCES" });
  } finally {
    await chmod(source, 0o600);
  }
  const [attempt] = await readdir(f.archive);
  assert.ok(attempt);
  const archived = join(f.archive, attempt!, "state");
  assert.equal(await readFile(join(archived, "journal/events.jsonl"), "utf8"), "prior journal");
  assert.equal(await readFile(join(archived, "snapshots/session/original.png"), "utf8"), "prior snapshot");
  assert.equal(await readFile(source, "utf8"), "fresh journal");
  assert.ok((await lstat(f.destination)).isDirectory());
});

test("a missing incoming tree never archives existing state", async t => {
  const f = await fixture(t);
  await save(f.destination, "journal/events.jsonl", "prior");
  await rm(f.incoming, { recursive: true });
  await assert.rejects(f.refresh(), /missing incoming evidence state/);
  assert.equal(await readFile(join(f.destination, "journal/events.jsonl"), "utf8"), "prior");
  await absent(f.archive);
});
