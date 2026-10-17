import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, writeFile, copyFile, rm, symlink, readdir, rename, realpath, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command, inventory, within } from '../src/util.js';
import { probeLocal } from '../src/probe.js';

test('real file transfer checks source and destination; rejects mutation and symlinks', async () => {
 const root = await mkdtemp(join(tmpdir(), 'relay-transfer-'));
 try {
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'a'), 'hello');
  const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
  const transfer = new Transfer(channel, 'fake-vm', process.execPath);
  await transfer.pushFile(join(source, 'a'), join(root, 'staged', 'a'));
  await transfer.pullVerified(source, join(root, 'delivered'));
  assert.deepEqual(await inventory(source), await inventory(join(root, 'delivered')));
  await symlink('/etc/passwd', join(source, 'link'));
  await assert.rejects(transfer.pullVerified(source, join(root, 'bad')), /symlink/);
  await rm(join(source, 'link'));
  channel.pull = async (_name, r, l) => { await copyFile(r, l); await writeFile(l, 'corrupted'); };
  await assert.rejects(transfer.pullVerified(join(source, 'a'), join(root, 'bad-file')), /checksum mismatch/);
  channel.pull = async (_name, r, l) => { await copyFile(r, l); await writeFile(r, 'source changed'); };
  await assert.rejects(transfer.pullVerified(join(source, 'a'), join(root, 'changed')), /Source changed/);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('inventory frames survive the vm-service 64000-character stdout tail and are cleaned', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), source = join(guest, 'workspace'), temp = join(root, 'host-temp');
 await mkdir(source, { recursive: true });
 await Promise.all(Array.from({ length: 750 }, (_, n) => writeFile(join(source, `${String(n).padStart(4, '0')}-${'long-name-'.repeat(9)}`), String(n))));
 const original = await inventory(source); assert.ok(JSON.stringify(original).length > 64000);
 const stdoutSizes: number[] = [], pulled: string[] = [];
 const channel: VmChannel = {
  exec: async (_name, argv) => { const result = await command(argv, { maxBytes: 64 * 1024 * 1024 }); stdoutSizes.push(result.stdout.length); return { ...result, stdout: result.stdout.slice(-64000) }; },
  push: async (_name, l, r) => copyFile(l, r),
  pull: async (_name, r, l) => { pulled.push(r); return copyFile(r, l); },
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: temp });
 assert.deepEqual(await transfer.scan(source, guest), original);
 assert.ok(pulled.some(path => path.startsWith(join(guest, '.inventory-'))));
 assert.ok(stdoutSizes.every(size => size < 1000), 'exec only carries bounded acknowledgements');
 assert.deepEqual(await readdir(guest), ['workspace']); assert.deepEqual(await readdir(temp), []);
});

test('file framing scans more than 10000 files: delivering relay evidence has no file-count bound (PS-D12)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-count-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const source = join(root, 'workspace'); await mkdir(source);
 for (let start = 0; start < 10000; start += 100) await Promise.all(Array.from({ length: 100 }, (_, n) => writeFile(join(source, String(start + n).padStart(5, '0')), '')));
 await writeFile(join(source, '10000'), '');
 const channel: VmChannel = {
  exec: async (_name, argv) => { const result = await command(argv, { maxBytes: 16 * 1024 * 1024 }); return { ...result, stdout: result.stdout.slice(-64000) }; },
  push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l),
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root, hostTempRoot: join(root, 'temp') });
 const facts = await transfer.scan(source, root); assert.equal(facts.length, 10001); assert.ok(facts.every(f => f.bytes === 0));
 assert.deepEqual(await readdir(root), ['temp', 'workspace']); assert.deepEqual(await readdir(join(root, 'temp')), []);
});

test('inventory frame corruption fails closed and cleans both temporary copies', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-bad-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), source = join(guest, 'workspace'), temp = join(root, 'host-temp');
 await mkdir(source, { recursive: true }); await writeFile(join(source, 'a'), 'a');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => { await copyFile(r, l); await writeFile(l, '[]'); } };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: temp });
 await assert.rejects(transfer.scan(source, guest), /checksum mismatch/);
 assert.deepEqual(await readdir(guest), ['workspace']); assert.deepEqual(await readdir(temp), []);
});

test('approved roots reject symlink ancestors, including changes during extraction and staging', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-ancestors-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), workspace = join(guest, 'workspace'), outside = join(root, 'outside'), host = join(root, 'host');
 await mkdir(join(workspace, 'nested'), { recursive: true }); await mkdir(outside); await mkdir(host);
 await writeFile(join(outside, 'secret'), 'secret'); await writeFile(join(workspace, 'nested/a'), 'safe');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
 await symlink(outside, join(workspace, 'escape'));
 await assert.rejects(transfer.pullVerified(join(workspace, 'escape/secret'), join(host, 'bad'), workspace), /symlink ancestor/);
 await assert.rejects(transfer.pullVerified(join(outside, 'secret'), join(host, 'bad'), workspace), /Path must be inside/);
 await symlink(outside, join(host, 'escape'));
 await assert.rejects(transfer.pushFile(join(host, 'escape/secret'), join(workspace, 'staged'), host), /symlink ancestor/);
 await assert.rejects(transfer.pullVerified(join(workspace, 'nested/a'), join(host, 'escape/overwrite'), workspace, host), /symlink ancestor/);
 await assert.rejects(transfer.pushFile(join(outside, 'secret'), join(workspace, 'escape/overwrite')), /symlink ancestor/);
 channel.pull = async (_name, r, l) => {
  await copyFile(r, l);
  if (r === join(workspace, 'nested/a')) { await rename(join(workspace, 'nested'), join(workspace, 'old')); await symlink(join(workspace, 'old'), join(workspace, 'nested')); }
 };
 await assert.rejects(transfer.pullVerified(join(workspace, 'nested/a'), join(host, 'changed'), workspace), /symlink ancestor/);
 await rm(join(workspace, 'nested')); await rename(join(workspace, 'old'), join(workspace, 'nested'));
 channel.push = async (_name, l, r) => { await copyFile(l, r); await writeFile(l, 'mutated'); };
 await assert.rejects(transfer.pushFile(join(workspace, 'nested/a'), join(workspace, 'staged'), workspace), /Staging source changed/);
});

test('OS symlink ancestors above approved roots remain usable', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-alias-'))); t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, 'real/workspace'), { recursive: true }); await symlink(join(root, 'real'), join(root, 'alias'));
 const approved = join(root, 'alias/workspace'); await writeFile(join(approved, 'a'), 'safe');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: approved });
 await transfer.pullVerified(join(approved, 'a'), join(root, 'result'), approved);
 assert.equal(await readFile(join(root, 'result'), 'utf8'), 'safe');
});

test('remote inventory scans a file over 512 MiB, and over one Node.js read, without carrying its bytes; it rejects special files', { timeout: 60000 }, async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-large-'))); t.after(() => rm(root, { recursive: true, force: true }));
 // Sparse, so the test uses no disk space. 2 GiB + 1 byte passes both the removed
 // 512 MiB bound and the 2 GiB limit of a single fs.readFileSync.
 const size = 2 * 1024 * 1024 * 1024 + 1;
 await writeFile(join(root, 'large'), ''); await truncate(join(root, 'large'), size);
 const channel: VmChannel = { exec: async (_name, argv) => command(argv, { timeoutMs: 60000 }), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => { assert.match(r, /\/\.inventory-[^/]+\.json$/, 'only the inventory frame is pulled'); return copyFile(r, l); } };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root, hostTempRoot: join(root, 'temp') });
 // SHA-256 of 2 GiB + 1 zero bytes.
 assert.deepEqual(await transfer.scan(join(root, 'large'), root), [{ path: '', sha256: 'b8030a8ab89280935633d8d991da3d9907c0f12e8b6fc3bfc515f4d440872b6e', bytes: size }]);
 await command(['/usr/bin/mkfifo', join(root, 'fifo')]);
 await assert.rejects(transfer.scan(join(root, 'fifo'), root), /special file/);
});

test('the guest scan timeout grows with the bytes it hashes instead of a fixed 120 s', { timeout: 60000 }, async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-scan-timeout-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const state = join(root, 'state'); await mkdir(state);
 const size = 1024 * 1024 * 1024; // sparse, so no disk space is used
 await writeFile(join(state, 'large.png'), ''); await truncate(join(state, 'large.png'), size);
 const timeouts: number[] = [];
 const channel: VmChannel = {
  exec: async (_name, argv, timeoutMs) => { timeouts.push(timeoutMs ?? 0); return command(argv, { timeoutMs: 60000 }); },
  push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l),
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root, hostTempRoot: join(root, 'temp') });
 const facts = await transfer.scan(state, root); assert.equal(facts[0].bytes, size);
 // A state larger than a fixed 120 s of hashing must not time out: the scan allows
 // at least 8 MiB/s of hashing on top of the 120 s base.
 assert.ok(Math.max(...timeouts) >= 120000 + (size / (8 * 1024 * 1024)) * 1000, `the longest guest command timeout was ${Math.max(...timeouts)} ms`);
});

test('path traversal rejected before IO', () => {
 for (const path of ['', '..', '../x', '/elsewhere', 'a\\b', 'a\0b', '.']) assert.throws(() => within('/safe', path));
 assert.equal(within('/safe', 'folder/file'), '/safe/folder/file');
});

test('probe remains read-only; unknown is not no user activity', async () => {
 const called: string[][] = [];
 const unavailable = await probeLocal(async argv => { called.push([...argv]); throw Error('unavailable'); });
 assert.equal(unavailable.screenshot.available, null); assert.equal(unavailable.userSessionActive.value, null);
 // Facts only: the probe recommends nothing, local work included (DC-14).
 assert.equal(Object.hasOwn(unavailable, 'recommendation'), false);
 assert.ok(called.every(argv => !argv.includes('grant') && !argv.includes('get_desktop_state')));
 const probe = await probeLocal(async argv => {
  const output = argv.includes('permissions') ? JSON.stringify({ screen_recording: true, accessibility: true }) : argv.includes('list_apps') ? '{"apps":[]}' : argv.includes('IOHIDSystem') ? '"HIDIdleTime" = 5000000000' : argv.includes('/dev/console') ? 'root\n' : '{}';
  return { stdout: output, stderr: '', code: 0 };
 }, 'darwin');
 assert.equal(probe.idleSeconds.value, 5); assert.equal(probe.userSessionActive.value, false);
 assert.equal(Object.hasOwn(probe, 'recommendation'), false);
});

test('local helper bounds output and timeouts', async () => {
 await assert.rejects(command([process.execPath, '-e', "console.log('x'.repeat(1000))"], { maxBytes: 10 }), /output exceeded/);
 await assert.rejects(command([process.execPath, '-e', 'setInterval(()=>{},100)'], { timeoutMs: 10 }), /timed out/);
});

/** The fake vm-service pull keeps holes, so a sparse stand-in for evidence uses no disk space when it is pulled. */
async function sparseCopy(source: string, destination: string) {
 const input = await open(source, 'r'), output = await open(destination, 'wx');
 try {
  const chunk = Buffer.alloc(1024 * 1024); let position = 0;
  for (;;) {
   const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
   if (!bytesRead) break;
   if (chunk.subarray(0, bytesRead).some(byte => byte !== 0)) await output.write(chunk, 0, bytesRead, position);
   position += bytesRead;
  }
  await output.truncate(position);
 } finally { await input.close(); await output.close(); }
}

test('R8 (PS-D12): relay state of about 14 MiB per recorded step scans and pulls past 512 MiB at step 37', { timeout: 60000 }, async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-state-size-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const state = join(root, 'state', 'snapshots'); await mkdir(state, { recursive: true });
 const channel: VmChannel = {
  exec: async (_name, argv) => { const result = await command(argv, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60000 }); return { ...result, stdout: result.stdout.slice(-64000) }; },
  push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => sparseCopy(r, l),
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root, hostTempRoot: join(root, 'temp') });
 // Sparse stand-ins for one step's before and after display PNGs, 7 MiB each.
 const step = async (n: number) => { for (const phase of ['before', 'after']) { const path = join(state, `step-${String(n).padStart(3, '0')}-${phase}.png`); await writeFile(path, ''); await truncate(path, 7 * 1024 * 1024); } };
 for (let n = 1; n <= 37; n++) await step(n);
 const facts = await transfer.scan(join(root, 'state'), root);
 assert.equal(facts.length, 74); assert.equal(facts.reduce((sum, fact) => sum + fact.bytes, 0), 37 * 14 * 1024 * 1024, 'the 37th step brings the state to 518 MiB');
 const pulled = await transfer.pullVerified(join(root, 'state'), join(root, 'host', 'state'), root, join(root, 'host'));
 assert.deepEqual(pulled, facts, 'the whole 518 MiB state is delivered, so finish can package it');
 assert.deepEqual(await inventory(join(root, 'host', 'state')), facts);
});

test('pullVerified copies matching host files instead of pulling them, and never uses a candidate with the wrong hash (AD-6)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-reuse-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const source = join(root, 'guest', 'state'), held = join(root, 'host');
 await mkdir(join(source, 'snapshots'), { recursive: true }); await mkdir(join(held, 'state', 'snapshots'), { recursive: true }); await mkdir(join(held, 'images'), { recursive: true });
 await writeFile(join(source, 'snapshots', 'a.png'), 'original a'); await writeFile(join(source, 'snapshots', 'b.png'), 'original b'); await writeFile(join(source, 'journal'), 'entries');
 await writeFile(join(held, 'state', 'snapshots', 'a.png'), 'original a');
 await writeFile(join(held, 'images', 'b.png'), 'tampered b'); // same size, wrong bytes
 const pulled: string[] = [];
 // The files the host lacks come in one archive (AD-9): its command names them after its five fixed arguments.
 const channel: VmChannel = { exec: async (_name, argv) => { if (argv[2]?.includes('Not a regular file')) pulled.push(...argv.slice(8).map(path => join(source, path))); return command(argv); }, push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => { pulled.push(r); return copyFile(r, l); } };
 const transfer = new Transfer(channel, 'fake-vm', process.execPath);
 const reuse = { root: held, candidates: (file: { path: string }) => [join(held, 'state', file.path), ...(file.path.endsWith('b.png') ? [join(held, 'images', 'b.png')] : [])] };
 const local = join(root, 'attempt', 'state');
 await transfer.pullVerified(source, local, source, root, { reuse });
 assert.deepEqual(await inventory(local), await inventory(source));
 assert.equal((reuse as { reused?: number }).reused, 1);
 assert.deepEqual(pulled.filter(path => !/\/\.(?:inventory|archive)-/.test(path)).sort(), [join(source, 'journal'), join(source, 'snapshots', 'b.png')]);
 assert.equal(await readFile(join(held, 'images', 'b.png'), 'utf8'), 'tampered b', 'a rejected candidate is left alone');
 const outside = { root: join(held, 'images'), candidates: () => [join(held, 'state', 'snapshots', 'a.png')] };
 await transfer.pullVerified(source, join(root, 'outside', 'state'), source, root, { reuse: outside });
 assert.equal((outside as { reused?: number }).reused, undefined, 'a candidate outside the declared root is not used');
 assert.ok(pulled.includes(join(source, 'snapshots', 'a.png')));
});
