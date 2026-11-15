import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveBytes, archiveChunks, unpackArchive, type ArchiveEntry } from '../src/archive.js';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command, hash, inventory } from '../src/util.js';

const entry = (path: string, body: string): ArchiveEntry => ({ path, bytes: Buffer.byteLength(body), sha256: hash(body) });
const pack = (files: Array<{ path: string; body: string; bytes?: number; sha256?: string }>) =>
 Buffer.concat(files.flatMap(file => [Buffer.from(`${JSON.stringify({ path: file.path, bytes: file.bytes ?? Buffer.byteLength(file.body) })}\n`), Buffer.from(file.body), Buffer.from(`${JSON.stringify({ sha256: file.sha256 ?? hash(file.body) })}\n`)]));

test('an archive unpacks byte for byte, and its size is known before the guest writes it (AD-8)', async t => {
 const root = await mkdtemp(join(tmpdir(), 'relay-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
 const files = [{ path: 'records/a.json', body: '{"a":1}' }, { path: 'snapshots/s/b.png', body: 'png\nwith\nnewlines' }, { path: 'empty', body: '' }];
 const bytes = pack(files); await writeFile(join(root, 'archive'), bytes);
 const expected = files.map(file => entry(file.path, file.body));
 assert.equal(archiveBytes(expected), bytes.length);
 await unpackArchive(join(root, 'archive'), join(root, 'out'), expected);
 for (const file of files) assert.equal(await readFile(join(root, 'out', file.path), 'utf8'), file.body);
});

test('an archive is rejected for traversal, unrequested or duplicate paths, wrong sizes or hashes, truncation and trailing bytes (AD-8)', async t => {
 const root = await mkdtemp(join(tmpdir(), 'relay-archive-bad-')); t.after(() => rm(root, { recursive: true, force: true }));
 const a = { path: 'a', body: 'alpha' }, b = { path: 'b', body: 'beta' };
 const cases: Array<[string, Buffer, ArchiveEntry[], RegExp]> = [
  ['traversal', pack([{ path: '../a', body: 'alpha' }]), [entry('../a', 'alpha')], /Invalid relative path/],
  ['absolute', pack([{ path: '/etc/a', body: 'alpha' }]), [entry('/etc/a', 'alpha')], /Invalid relative path/],
  ['unrequested', pack([b]), [entry('a', 'alpha')], /Unexpected archive entry/],
  ['duplicate', pack([a, a]), [entry('a', 'alpha'), entry('b', 'beta')], /Unexpected archive entry/],
  ['size', pack([{ ...a, bytes: 4 }]), [entry('a', 'alpha')], /Unexpected archive entry/],
  ['hash line', pack([{ ...a, sha256: hash('other') }]), [entry('a', 'alpha')], /checksum mismatch/],
  ['expected hash', pack([a]), [{ ...entry('a', 'alpha'), sha256: hash('other') }], /checksum mismatch/],
  ['truncated', pack([a, b]).subarray(0, 30), [entry('a', 'alpha'), entry('b', 'beta')], /truncated/],
  ['trailing', Buffer.concat([pack([a]), Buffer.from('x')]), [entry('a', 'alpha')], /trailing bytes/],
  ['missing', pack([a]), [entry('a', 'alpha'), entry('b', 'beta')], /truncated/],
 ];
 for (const [name, bytes, expected, error] of cases) {
  const archive = join(root, `${name}.archive`); await writeFile(archive, bytes);
  await assert.rejects(unpackArchive(archive, join(root, name), expected), error, name);
 }
 await mkdir(join(root, 'linked')); await symlink(join(root, 'elsewhere'), join(root, 'linked', 'a'));
 await writeFile(join(root, 'link.archive'), pack([a]));
 await assert.rejects(unpackArchive(join(root, 'link.archive'), join(root, 'linked'), [entry('a', 'alpha')]), /EEXIST/, 'an existing link is never written through');
});

test('archive requests are split so no guest command carries more than the path budget', () => {
 const files = Array.from({ length: 10 }, (_, n) => ({ path: `${n}`.padStart(10, 'x') }));
 const chunks = archiveChunks(files, 33);
 assert.deepEqual(chunks.map(chunk => chunk.length), [3, 3, 3, 1]);
 assert.deepEqual(chunks.flat(), files);
});

const guestChannel = (log: string[]) => ({
 exec: async (_name: string, argv: string[]) => { log.push('exec'); return command(argv); },
 push: async (_name: string, l: string, r: string) => copyFile(l, r),
 pull: async (_name: string, r: string, l: string) => { log.push(`pull ${r}`); return copyFile(r, l); },
}) satisfies VmChannel;

test('pullVerified fetches what the host lacks in one archive, with a fixed number of requests (AD-9)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-pull-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 const write = async (count: number) => { for (let n = 0; n < count; n++) { await mkdir(join(state, 'records', String(n % 7)), { recursive: true }); await writeFile(join(state, 'records', String(n % 7), `${n}.json`), JSON.stringify({ n })); } };
 const requests = async (count: number) => {
  await rm(guest, { recursive: true, force: true }); await write(count);
  const log: string[] = [];
  const transfer = new Transfer(guestChannel(log), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
  const local = join(host, String(count), 'state');
  await transfer.pullVerified(state, local, guest, host);
  assert.deepEqual(await inventory(local), await inventory(state));
  assert.deepEqual(await readdir(guest), ['state'], 'the guest archive and frames are removed');
  assert.ok(!(await readdir(local)).some(name => name.startsWith('.relay-archive-')), 'the host staging is removed');
  assert.ok(log.filter(line => line.startsWith('pull ')).every(line => /\/\.(?:inventory|archive)-/.test(line)), 'no file is pulled on its own');
  return log.length;
 };
 assert.equal(await requests(5), await requests(200), 'the requests do not grow with the files');
});

test('pullVerified falls back to the per-file pull when the archive fails, and says why (AD-10)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-fallback-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 await mkdir(join(state, 'snapshots'), { recursive: true });
 await writeFile(join(state, 'snapshots', 'a.png'), 'a'); await writeFile(join(state, 'journal'), 'j');
 const log: string[] = [], fallbacks: string[] = [];
 const channel = guestChannel(log);
 const pull = channel.pull;
 channel.pull = async (name, r, l) => { if (r.includes('/.archive-')) { await pull(name, r, l); await writeFile(l, 'corrupt'); return; } return pull(name, r, l); };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
 const local = join(host, 'state');
 await transfer.pullVerified(state, local, guest, host);
 assert.deepEqual(await inventory(local), await inventory(state));
 assert.equal(fallbacks.length, 1); assert.match(fallbacks[0], /Archive size mismatch/);
 assert.deepEqual(log.filter(line => line.startsWith('pull ') && !/\/\.(?:inventory|archive)-/.test(line)).sort(), [`pull ${join(state, 'journal')}`, `pull ${join(state, 'snapshots', 'a.png')}`]);
 assert.deepEqual(await readdir(guest), ['state']);
});

test('the guest refuses to archive a link or a file outside the tree, and leaves no partial archive', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-guest-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 await mkdir(state, { recursive: true }); await writeFile(join(root, 'secret'), 'secret'); await writeFile(join(state, 'a'), 'a');
 const fallbacks: string[] = [];
 const transfer = new Transfer(guestChannel([]), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
 // The scan sees a regular file; it becomes a link before the archive reads it.
 const channel = (transfer as unknown as { vm: VmChannel }).vm, exec = channel.exec;
 channel.exec = async (name, argv, ...rest) => {
  if (argv.length > 6 && argv[2].includes('Not a regular file')) { await rm(join(state, 'a')); await symlink(join(root, 'secret'), join(state, 'a')); }
  return exec(name, argv, ...rest);
 };
 await assert.rejects(transfer.pullVerified(state, join(host, 'state'), guest, host), /symlink|Source changed|inventory mismatch/);
 assert.match(fallbacks[0], /Not a regular file|symlink/);
 assert.deepEqual(await readdir(guest), ['state']);
});

const tree = async (root: string, count: number) => {
 for (let n = 0; n < count; n++) { await mkdir(join(root, 'files', String(n % 7)), { recursive: true }); await writeFile(join(root, 'files', String(n % 7), `${n}.txt`), `file ${n}\n`.padEnd(64, '.')); }
 await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho staged\n', { mode: 0o755 });
};
const pushes = (log: string[]) => ({
 exec: async (_name: string, argv: string[]) => { log.push('exec'); return command(argv, { maxBytes: 16 * 1024 * 1024 }); },
 push: async (_name: string, l: string, r: string) => { log.push(`push ${r}`); return copyFile(l, r); },
 pull: async (_name: string, r: string, l: string) => { log.push(`pull ${r}`); return copyFile(r, l); },
}) satisfies VmChannel;
const pushSetup = async (prefix: string, t: { after: (fn: () => Promise<void>) => void }) => {
 const root = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(root, { recursive: true, force: true }));
 const project = join(root, 'project'), workspace = join(project, 'workspace'), guest = join(root, 'guest'), remote = join(guest, 'workspace');
 await mkdir(workspace, { recursive: true }); await mkdir(remote, { recursive: true });
 return { root, project, workspace, guest, remote };
};

test('pushTree stages a tree in archives: every file arrives with its hash and mode, in a fixed number of requests (AD-11)', async t => {
 const counts: number[] = [];
 for (const count of [5, 300]) {
  const { root, project, workspace, guest, remote } = await pushSetup('relay-archive-push-', t);
  await tree(workspace, count);
  const log: string[] = [], fallbacks: string[] = [];
  const transfer = new Transfer(pushes(log), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
  const staged = await transfer.pushTree(workspace, remote, project);
  const source = await inventory(workspace);
  assert.deepEqual(await inventory(remote), source, 'every file arrives with its hash');
  assert.deepEqual(staged, source.map(file => ({ local: join(workspace, file.path), remote: join(remote, file.path), sha256: file.sha256, bytes: file.bytes })), 'the staged results keep their shape and order');
  assert.equal((await stat(join(remote, 'run.sh'))).mode & 0o777, 0o755, 'an executable stays executable');
  assert.deepEqual(fallbacks, []);
  assert.ok(log.filter(line => line.startsWith('push ')).every(line => line.startsWith(`push ${join(guest, '.archive-')}`)), 'no file is pushed on its own');
  assert.deepEqual(await readdir(guest), ['workspace'], 'the guest archive and staging folder are removed');
  assert.deepEqual(await readdir(join(root, 'temp')), [], 'the host archive is removed');
  counts.push(log.length);
 }
 assert.equal(counts[0], counts[1], 'the requests do not grow with the files');
});

test('a tampered or short pushed archive is refused and leaves no file in the guest (AD-11)', async t => {
 const { root, project, workspace, guest, remote } = await pushSetup('relay-archive-tamper-', t);
 await tree(workspace, 3);
 const files = await inventory(workspace);
 const tampers: Array<[string, (path: string) => Promise<void>, RegExp]> = [
  ['short', async path => { await writeFile(path, (await readFile(path)).subarray(0, 40)); }, /Archive size mismatch/],
  ['flipped byte', async path => { const bytes = await readFile(path); bytes[bytes.indexOf(10) + 3] ^= 1; await writeFile(path, bytes); }, /checksum mismatch/],
  ['consistent rewrite', async path => {
   const bytes = await readFile(path), first = bytes.indexOf(10), body = bytes.subarray(first + 1, first + 1 + files[0].bytes);
   body[0] ^= 1; const sha256 = hash(body), end = bytes.indexOf(10, first + 1 + files[0].bytes);
   await writeFile(path, Buffer.concat([bytes.subarray(0, first + 1), body, Buffer.from(`${JSON.stringify({ sha256 })}`), bytes.subarray(end)]));
  }, /Archive checksum mismatch/],
 ];
 for (const [name, tamper, error] of tampers) {
  const channel = pushes([]);
  channel.push = async (_name, l, r) => { await copyFile(l, r); await tamper(r); };
  const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
  await assert.rejects(transfer.pushArchive(workspace, remote, files, project), error, name);
  assert.deepEqual(await readdir(remote), [], `${name}: no file, whole or partial, is in the workspace`);
  assert.deepEqual(await readdir(guest), ['workspace'], `${name}: the archive and the staging folder are removed`);
 }
});

test('a path that escapes the workspace is refused inside a pushed archive (AD-11)', async t => {
 const { root, project, workspace, guest, remote } = await pushSetup('relay-archive-escape-', t);
 await writeFile(join(workspace, 'aaaaaaaaa'), 'alpha');
 const files = await inventory(workspace);
 // The archive names a path outside the workspace in place of the requested one, of the same length.
 const channel = pushes([]);
 channel.push = async (_name, l, r) => { const bytes = await readFile(l); await writeFile(r, Buffer.concat([Buffer.from(`${JSON.stringify({ path: '../escape', bytes: 5 })}\n`), bytes.subarray(bytes.indexOf(10) + 1)])); assert.equal((await readFile(r)).length, bytes.length); };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
 await assert.rejects(transfer.pushArchive(workspace, remote, files, project), /Unexpected archive entry: \.\.\/escape/);
 // The guest command is asked for a path outside the workspace.
 const exec = channel.exec;
 channel.push = pushes([]).push;
 channel.exec = async (name, argv) => exec(name, argv.length > 7 && argv[2].includes('Invalid archive path') ? [...argv.slice(0, -1), '../escape'] : argv);
 await assert.rejects(transfer.pushArchive(workspace, remote, files, project), /Invalid archive path/);
 // A link in the guest workspace is never written through.
 channel.exec = exec;
 await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(remote, 'linked'));
 await writeFile(join(workspace, 'b'), 'beta'); await mkdir(join(workspace, 'linked')); await writeFile(join(workspace, 'linked', 'c'), 'gamma');
 await assert.rejects(transfer.pushArchive(workspace, remote, await inventory(workspace), project), /symlink/);
 assert.deepEqual(await readdir(join(root, 'outside')), []);
 assert.deepEqual((await readdir(remote)).sort(), ['linked']);
 assert.deepEqual(await readdir(guest), ['workspace'], 'nothing escaped beside the workspace');
 // On the host, a link in the workspace refuses the stage and is never followed.
 await rm(join(workspace, 'linked'), { recursive: true }); await symlink(join(root, 'outside'), join(workspace, 'linked'));
 await assert.rejects(transfer.pushTree(workspace, remote, project), /Symlinks are not transferable/);
});

test('pushTree falls back to the per-file push when the archive fails, and says why (AD-11)', async t => {
 const { root, project, workspace, guest, remote } = await pushSetup('relay-archive-push-fallback-', t);
 await tree(workspace, 4);
 const log: string[] = [], fallbacks: Array<{ remote: string; files: number; diagnostic: string; direction?: string }> = [];
 const channel = pushes(log), push = channel.push;
 channel.push = async (name, l, r) => { if (r.includes('/.archive-')) { await push(name, l, r); await writeFile(r, 'corrupt'); return; } return push(name, l, r); };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event); } });
 const staged = await transfer.pushTree(workspace, remote, project);
 const source = await inventory(workspace);
 assert.deepEqual(await inventory(remote), source);
 assert.deepEqual(staged.map(file => file.sha256), source.map(file => file.sha256));
 assert.equal(fallbacks.length, 1); assert.equal(fallbacks[0].files, source.length); assert.equal(fallbacks[0].direction, 'push'); assert.equal(fallbacks[0].remote, remote);
 assert.match(fallbacks[0].diagnostic, /Archive size mismatch/);
 assert.deepEqual(log.filter(line => line.startsWith('push ') && !line.includes('/.archive-')).sort(), source.map(file => `push ${join(remote, file.path)}`).sort(), 'each file is then pushed on its own');
 assert.deepEqual(await readdir(guest), ['workspace']);
});

test('a host file that changes while it is packed refuses the stage without the fallback (AD-11)', async t => {
 const { root, project, workspace, guest, remote } = await pushSetup('relay-archive-push-changed-', t);
 await tree(workspace, 3);
 const files = await inventory(workspace);
 await writeFile(join(workspace, 'run.sh'), 'changed');
 const fallbacks: string[] = [];
 const transfer = new Transfer(pushes([]), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
 await assert.rejects(transfer.pushArchive(workspace, remote, files, project), /Staging source changed/);
 assert.deepEqual(fallbacks, []);
 assert.deepEqual(await readdir(remote), []);
 assert.deepEqual(await readdir(join(root, 'temp')), []);
});
