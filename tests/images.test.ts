import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ImageStore, type ImageStoreOptions } from '../src/images.js';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command, hash, jsonFile } from '../src/util.js';
import type { GuestRequest, GuestResponse, GuestSnapshotDescriptor } from '../src/guest/receiver.js';

function png(): Buffer {
 const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) {
   crc ^= byte;
   for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
 };
 const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
 return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const original = png();
const target = { source: 'display', sessionId: 'session-one', executionId: 'execution-one', phase: 'after' } as const;

async function setup(t: TestContext) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-images-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const hostRoot = join(root, 'recording-one'), guestRoot = join(root, 'guest'), state = join(guestRoot, 'state');
 const calls = { exec: [] as string[][], pull: [] as string[], ensure: 0, push: 0 };
 const controls = { offline: false, failImagePull: false };
 const channel: VmChannel = {
  exec: async (_name, argv, timeoutMs, options) => {
   calls.exec.push(argv);
   assert.equal(argv[0], process.execPath); assert.equal(argv[1], '-e');
   assert.ok(argv[2].includes('lstatSync'), 'only read-only metadata commands are permitted');
   if (controls.offline) throw new Error('connection unavailable');
   return command(argv, { ...options, timeoutMs: options?.timeoutMs ?? timeoutMs });
  },
  push: async () => { calls.push++; assert.fail('image lookup must never stage or dispatch input'); },
  pull: async (_name, remote, local) => {
   calls.pull.push(remote);
   if (controls.offline || (controls.failImagePull && remote.endsWith('.png'))) throw new Error('connection unavailable');
   await copyFile(remote, local);
  },
 };
 const options: ImageStoreOptions = {
  owner: 'owner-one', enclosure: 'enclosure-one', backend: { service: 'local-fixture' },
  catalogRoot: join(root, 'catalog'), hostRoot, guestRoot, sessionId: target.sessionId,
  declarations: [{ name: 'shots', path: 'shots' }, { name: 'single', path: 'single.png' }],
  transfer: new Transfer(channel, 'local-fixture', process.execPath, { guestRoot }),
  ensureGuest: async () => { calls.ensure++; if (controls.offline) throw new Error('connection unavailable'); },
 };
 const request: GuestRequest = { executionId: target.executionId, sessionId: target.sessionId, attemptId: 'attempt-one', because: 'fixture', language: 'shell', code: 'fixture', codeSha256: '0'.repeat(64), snapshots: { afterIntervalMs: 0 }, step: { id: 'step-one', title: 'fixture' } };
 const snapshot: GuestSnapshotDescriptor = {
  sessionId: target.sessionId, attemptId: 'attempt-one', executionId: target.executionId, actionId: 'action-one', stepId: 'step-one',
  phase: 'after', capturedAt: '2026-09-21T00:00:00.000Z', sha256: hash(original), bytes: original.length,
  mimeType: 'image/png', fileName: 'saved-after.png', declaredAfterIntervalMs: 0,
 };
 const receipt: GuestResponse = { executionId: target.executionId, outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } }, imageEvidence: { status: 'available', snapshots: [snapshot] } };
 const action = {
  actionId: snapshot.actionId, sessionId: snapshot.sessionId, executionId: snapshot.executionId, attemptId: snapshot.attemptId, stepId: snapshot.stepId,
  state: 'recorded', snapshotRole: 'single', snapshots: [{ fileName: snapshot.fileName, sha256: snapshot.sha256, bytes: snapshot.bytes, role: snapshot.phase, capturedAt: snapshot.capturedAt, declaredAfterIntervalMs: 0 }],
 };
 const requestPath = join(hostRoot, 'host/requests', `${target.executionId}.json`);
 const receiptPath = join(state, 'receiver/receipts', `${target.executionId}.json`);
 const actionPath = join(state, 'records/action', `${snapshot.actionId}.json`);
 const imagePath = join(state, 'snapshots', target.sessionId, snapshot.fileName);
 await jsonFile(requestPath, request); await jsonFile(receiptPath, receipt); await jsonFile(actionPath, action);
 await mkdir(dirname(imagePath), { recursive: true }); await writeFile(imagePath, original);
 await mkdir(join(guestRoot, 'workspace/shots'), { recursive: true });
 await writeFile(join(guestRoot, 'workspace/shots/one.png'), original);
 await writeFile(join(guestRoot, 'workspace/shots/sibling.png'), original);
 await writeFile(join(guestRoot, 'workspace/single.png'), original);
 return { root, hostRoot, guestRoot, state, calls, controls, options, request, snapshot, receipt, action, requestPath, receiptPath, actionPath, imagePath, store: new ImageStore(options) };
}

function noImageBytes(pulls: string[]) { assert.ok(pulls.every(path => path.endsWith('.json')), 'unverified metadata must never authorize an image pull'); }

test('display selection pulls the saved receipt, corroborating action and exact original only', async t => {
 const f = await setup(t), receiptBefore = await readFile(f.receiptPath), actionBefore = await readFile(f.actionPath);
 const result = await f.store.get(target);
 assert.equal(result.status, 'attached', result.diagnostic ?? 'no diagnostic'); assert.equal(result.content?.type, 'image');
 assert.equal(result.image?.sha256, hash(original)); assert.equal(result.image?.phase, 'after');
 assert.equal(result.image?.executionId, target.executionId); assert.equal(result.image?.actionId, f.snapshot.actionId);
 assert.deepEqual(f.calls.pull, [f.receiptPath, f.actionPath, f.imagePath]);
 assert.deepEqual(await readFile(result.image!.originalPath!), original);
 assert.deepEqual(await readFile(f.receiptPath), receiptBefore); assert.deepEqual(await readFile(f.actionPath), actionBefore);
 assert.equal(f.calls.push, 0);
});

for (const field of ['sessionId', 'actionId', 'phase'] as const) test(`rejects receipt descriptor with wrong ${field} before image transfer`, async t => {
 const f = await setup(t);
 Object.assign(f.receipt.imageEvidence!.snapshots[0]!, { [field]: field === 'phase' ? 'before' : 'foreign' });
 await jsonFile(f.receiptPath, f.receipt);
 assert.equal((await f.store.get(target)).status, 'integrity-failed'); noImageBytes(f.calls.pull);
});

for (const change of ['session', 'action', 'execution', 'phase', 'absent'] as const) test(`rejects ${change} mismatch in authoritative action metadata`, async t => {
 const f = await setup(t);
 const action: any = structuredClone(f.action);
 if (change === 'session') action.sessionId = 'foreign';
 if (change === 'action') action.actionId = 'foreign';
 if (change === 'execution') action.executionId = 'foreign';
 if (change === 'phase') action.snapshots[0].role = 'before';
 if (change === 'absent') delete action.snapshots;
 await jsonFile(f.actionPath, action);
 assert.equal((await f.store.get(target)).status, 'integrity-failed'); noImageBytes(f.calls.pull);
});

test('reference cache works with the guest offline and performs no guest calls', async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const counts = structuredClone(f.calls); f.controls.offline = true;
 const next = await new ImageStore(f.options).get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(next.status, 'attached', next.diagnostic ?? 'no diagnostic'); assert.equal(next.image!.imageId, first.image!.imageId);
 assert.equal(next.image!.sha256, first.image!.sha256); assert.deepEqual(f.calls, counts);
});

test('failed byte delivery issues a durable reference whose retry returns the same original', async t => {
 const f = await setup(t); f.controls.failImagePull = true;
 const failed = await f.store.get(target);
 assert.equal(failed.status, 'transfer-failed'); assert.ok(failed.image?.imageId);
 assert.equal(f.calls.pull.filter(path => path.endsWith('.png')).length, 1, 'receipt and action share the three-attempt budget');
 f.controls.failImagePull = false; const metadataPulls = f.calls.pull.filter(path => path.endsWith('.json')).length;
 const recovered = await new ImageStore(f.options).get({ source: 'reference', imageId: failed.image!.imageId });
 assert.equal(recovered.status, 'attached', recovered.diagnostic ?? 'no diagnostic');
 assert.equal(recovered.image!.imageId, failed.image!.imageId); assert.equal(recovered.image!.sha256, hash(original));
 assert.equal(f.calls.pull.filter(path => path.endsWith('.json')).length, metadataPulls);
});

test('conflicting local original is retained rather than overwritten or repaired from guest', async t => {
 const f = await setup(t), first = await f.store.get(target); assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const conflict = Buffer.from(original); conflict[conflict.length - 1] ^= 1;
 await writeFile(first.image!.originalPath!, conflict);
 const counts = structuredClone(f.calls);
 const result = await f.store.get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(result.status, 'integrity-failed'); assert.deepEqual(f.calls, counts);
 assert.deepEqual(await readFile(first.image!.originalPath!), conflict);
});

test('local original symlink is rejected as unsafe without reading or overwriting its target', async t => {
 const f = await setup(t), first = await f.store.get(target); assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const outside = join(f.root, 'outside.png'); await writeFile(outside, original);
 await rm(first.image!.originalPath!); await symlink(outside, first.image!.originalPath!);
 const counts = structuredClone(f.calls);
 const result = await f.store.get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(result.status, 'unsafe-path'); assert.deepEqual(f.calls, counts);
 assert.deepEqual(await readFile(outside), original);
});

test('guest image and ancestor symlinks cannot select outside declaration bytes', async t => {
 const f = await setup(t), outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.png'), original);
 await symlink(join(outside, 'secret.png'), join(f.guestRoot, 'workspace/shots/link.png'));
 await symlink(outside, join(f.guestRoot, 'workspace/shots/directory'));
 for (const path of ['link.png', 'directory/secret.png']) {
  const result = await f.store.get({ source: 'application', name: 'shots', path });
  assert.equal(result.status, 'unsafe-path'); assert.equal(result.image, undefined);
 }
 assert.deepEqual(f.calls.pull, []);
});

test('owner, enclosure and backend bindings reject foreign references without guest access', async t => {
 const f = await setup(t), first = await f.store.get(target); assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const counts = structuredClone(f.calls);
 for (const patch of [{ owner: 'other-owner' }, { enclosure: 'other-enclosure' }, { backend: { service: 'other-backend' } }]) {
  const result = await new ImageStore({ ...f.options, ...patch }).get({ source: 'reference', imageId: first.image!.imageId });
  assert.equal(result.status, 'unauthorized-reference'); assert.equal(result.image, undefined);
 }
 for (const imageId of ['../../secret', `image-${'0'.repeat(64)}`]) assert.equal((await f.store.get({ source: 'reference', imageId })).status, 'unauthorized-reference');
 assert.deepEqual(f.calls, counts);
});

test('missing saved image reports image-missing while preserving its issued identity', async t => {
 const f = await setup(t); await rm(f.imagePath);
 const result = await f.store.get(target);
 assert.equal(result.status, 'image-missing'); assert.equal(result.image?.sha256, hash(original));
 assert.ok(result.image?.imageId); noImageBytes(f.calls.pull);
});

test('legacy receipt without imageEvidence remains capture-unknown and does not fetch action or image', async t => {
 const f = await setup(t); delete f.receipt.imageEvidence; await jsonFile(f.receiptPath, f.receipt);
 const result = await f.store.get(target);
 assert.equal(result.status, 'capture-unknown'); assert.equal(result.image, undefined);
 assert.deepEqual(f.calls.pull, [f.receiptPath]);
});

test('reset lineage recovers an untransferred reference from moved guest evidence with the same identity', async t => {
 const f = await setup(t); f.controls.failImagePull = true;
 const first = await f.store.get(target); assert.equal(first.status, 'transfer-failed'); assert.ok(first.image);
 const oldState = join(f.guestRoot, 'previous-state'); await rename(f.state, oldState); await mkdir(f.state);
 const newHost = join(f.root, 'recording-two'); await mkdir(newHost);
 const options = { ...f.options, hostRoot: newHost, sessionId: 'session-two', previousEvidence: [{ path: f.hostRoot, sessionId: target.sessionId, guestState: oldState }] };
 f.controls.failImagePull = false;
 const reset = new ImageStore(options);
 const recovered = await reset.get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(recovered.status, 'attached', recovered.diagnostic ?? 'no diagnostic'); assert.equal(recovered.image!.imageId, first.image!.imageId);
 assert.equal(recovered.image!.sha256, first.image!.sha256);
 assert.equal(f.calls.pull.at(-1), join(oldState, 'snapshots', target.sessionId, f.snapshot.fileName));
 const selected = await reset.get(target);
 assert.equal(selected.status, 'attached', selected.diagnostic ?? 'no diagnostic'); assert.equal(selected.image!.imageId, first.image!.imageId);
 const counts = structuredClone(f.calls);
 const foreign = await new ImageStore({ ...options, previousEvidence: [] }).get(target);
 assert.equal(foreign.status, 'unauthorized-reference'); assert.deepEqual(f.calls, counts);
});

test('application selection copies one declared image and rejects traversal and undeclared files', async t => {
 const f = await setup(t);
 const result = await f.store.get({ source: 'application', name: 'shots', path: 'one.png' });
 assert.equal(result.status, 'attached', result.diagnostic ?? 'no diagnostic'); assert.equal(result.image!.source, 'application');
 assert.equal(result.image!.sessionId, undefined); assert.equal(result.image!.path, 'one.png');
 assert.deepEqual(f.calls.pull, [join(f.guestRoot, 'workspace/shots/one.png')]);
 const count = f.calls.pull.length;
 for (const path of ['../single.png', '/tmp/file.png', 'a\\b.png', '', './one.png']) {
  assert.equal((await f.store.get({ source: 'application', name: 'shots', path })).status, 'unsafe-path');
 }
 assert.equal((await f.store.get({ source: 'application', name: 'unknown', path: 'one.png' })).status, 'unauthorized-reference');
 assert.equal((await f.store.get({ source: 'application', name: 'shots', path: 'missing.png' })).status, 'image-missing');
 assert.equal(f.calls.pull.length, count);
 assert.ok((await readdir(join(f.guestRoot, 'workspace/shots'))).includes('sibling.png'));
});

test('display selection reuses retained metadata and original while offline', async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const counts = structuredClone(f.calls); f.controls.offline = true;
 const recovered = await new ImageStore(f.options).get(target);
 assert.equal(recovered.status, 'attached', recovered.diagnostic ?? 'no diagnostic');
 assert.equal(recovered.image!.imageId, first.image!.imageId);
 assert.deepEqual(f.calls, counts);
});

test('old recording without guestState resolves local evidence and original without guest readiness', async t => {
 const f = await setup(t);
 await cp(f.state, join(f.hostRoot, 'state'), { recursive: true });
 f.controls.offline = true;
 const options = { ...f.options, hostRoot: join(f.root, 'recording-two'), sessionId: undefined,
  previousEvidence: [{ path: f.hostRoot, sessionId: target.sessionId }] };
 const first = await new ImageStore(options).get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 assert.deepEqual(await readFile(first.image!.originalPath!), original);
 const retry = await new ImageStore(options).get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(retry.status, 'attached', retry.diagnostic ?? 'no diagnostic');
 assert.deepEqual(f.calls, { exec: [], pull: [], ensure: 0, push: 0 });
});

for (const field of ['sha256', 'phase', 'fileName', 'remote'] as const) test(`catalogue mutation of ${field} cannot redirect an issued reference or materialization`, async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const path = join(f.options.catalogRoot, `${first.image!.imageId}.json`);
 const value = JSON.parse(await readFile(path, 'utf8'));
 if (field === 'sha256') value.descriptor.sha256 = '0'.repeat(64);
 if (field === 'phase') value.descriptor.phase = 'before';
 if (field === 'fileName') { value.fileName = 'different.png'; value.remote = join(f.state, 'snapshots', target.sessionId, value.fileName); }
 if (field === 'remote') value.remote = join(f.state, 'snapshots', target.sessionId, 'different.png');
 await writeFile(path, JSON.stringify(value));
 const counts = structuredClone(f.calls);
 const result = await f.store.get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(result.status, 'integrity-failed');
 await assert.rejects(f.store.materializeDisplayOriginals(f.hostRoot), { code: 'integrity-failed' });
 assert.deepEqual(f.calls, counts);
});

test('catalogue canonical identity is independent of JSON property order', async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const path = join(f.options.catalogRoot, `${first.image!.imageId}.json`);
 const value = JSON.parse(await readFile(path, 'utf8'));
 value.descriptor = Object.fromEntries(Object.entries(value.descriptor).reverse());
 await writeFile(path, JSON.stringify(value));
 const result = await f.store.get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(result.status, 'attached', result.diagnostic ?? 'no diagnostic');
});

for (const kind of ['oversized', 'fifo', 'truncated'] as const) test(`catalogue ${kind} fails promptly without guest access or overwriting evidence`, async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const path = join(f.options.catalogRoot, `${first.image!.imageId}.json`);
 await rm(path);
 if (kind === 'oversized') await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1));
 if (kind === 'truncated') await writeFile(path, '{');
 if (kind === 'fifo') assert.equal((await command(['mkfifo', path])).code, 0);
 const counts = structuredClone(f.calls);
 const result = await f.store.get({ source: 'reference', imageId: first.image!.imageId }, undefined, Date.now() + 1000);
 assert.equal(result.status, kind === 'fifo' ? 'unsafe-path' : 'integrity-failed');
 assert.deepEqual(f.calls, counts);
 if (kind === 'truncated') {
  assert.equal((await f.store.get(target)).status, 'integrity-failed');
  assert.equal(await readFile(path, 'utf8'), '{');
 }
});

test('catalogue publications are private regular files with no leftover temporary hard links', async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 const names = await readdir(f.options.catalogRoot);
 assert.deepEqual(names, [`${first.image!.imageId}.json`]);
 const info = await lstat(join(f.options.catalogRoot, names[0]!));
 assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1);
});

async function partialBefore(t: TestContext) {
 const f = await setup(t);
 const sn: GuestSnapshotDescriptor = { ...f.snapshot, phase: 'before', declaredAfterIntervalMs: undefined };
 const receipt = { ...f.receipt, imageEvidence: { status: 'capture-failed', snapshots: [sn] } };
 const action: any = { ...f.action }; delete action.snapshots;
 await jsonFile(f.receiptPath, receipt); await jsonFile(f.actionPath, action);
 await cp(f.state, join(f.hostRoot, 'state'), { recursive: true });
 const journal = [
  { kind: 'action-start', actionId: sn.actionId, sessionId: sn.sessionId, attemptId: sn.attemptId, executionId: sn.executionId, stepId: sn.stepId, snapshotPlan: { capturesBefore: true, capturesAfter: { afterIntervalMs: 0 }, role: 'single' } },
  { kind: 'snapshot-captured', actionId: sn.actionId, sessionId: sn.sessionId, attemptId: sn.attemptId, snapshot: { fileName: sn.fileName, role: sn.phase, sha256: sn.sha256, bytes: sn.bytes, capturedAt: sn.capturedAt } },
 ];
 const journalPath = join(f.hostRoot, 'state/journal/events.jsonl');
 await mkdir(dirname(journalPath), { recursive: true });
 await writeFile(journalPath, journal.map(e => JSON.stringify(e)).join('\n') + '\n');
 f.controls.offline = true;
 return { ...f, sn, action, journal, journalPath };
}

test('guest-only partial capture retains identity after the shared budget is spent on corroboration', async t => {
 const f = await partialBefore(t);
 const guestJournal = join(f.state, 'journal/events.jsonl');
 await mkdir(dirname(guestJournal), { recursive: true });
 await writeFile(guestJournal, await readFile(f.journalPath));
 await rm(join(f.hostRoot, 'state'), { recursive: true });
 f.controls.offline = false;
 const first = await f.store.get({ ...target, phase: 'before' });
 assert.equal(first.status, 'transfer-failed', first.diagnostic ?? 'no diagnostic');
 assert.ok(first.image?.imageId); assert.equal(first.image!.sha256, hash(original));
 assert.deepEqual(f.calls.pull, [f.receiptPath, f.actionPath, guestJournal]);
 const next = await new ImageStore(f.options).get({ source: 'reference', imageId: first.image!.imageId });
 assert.equal(next.status, 'attached', next.diagnostic ?? 'no diagnostic');
 assert.equal(next.image!.imageId, first.image!.imageId);
 assert.deepEqual(f.calls.pull, [f.receiptPath, f.actionPath, guestJournal, f.imagePath]);
 f.controls.offline = true; const counts = structuredClone(f.calls);
 const selected = await new ImageStore(f.options).get({ ...target, phase: 'before' });
 assert.equal(selected.status, 'attached', selected.diagnostic ?? 'no diagnostic');
 assert.equal(selected.image!.imageId, first.image!.imageId); assert.deepEqual(f.calls, counts);
});

test('guest-only journal contradiction fails before issuing a reference or copying an image', async t => {
 const f = await partialBefore(t);
 const guestJournal = join(f.state, 'journal/events.jsonl');
 await mkdir(dirname(guestJournal), { recursive: true });
 const journal: any[] = structuredClone(f.journal); journal[1].snapshot.sha256 = '0'.repeat(64);
 await writeFile(guestJournal, journal.map(e => JSON.stringify(e)).join('\n') + '\n');
 await rm(join(f.hostRoot, 'state'), { recursive: true }); f.controls.offline = false;
 const result = await f.store.get({ ...target, phase: 'before' });
 assert.equal(result.status, 'integrity-failed'); assert.equal(result.image, undefined);
 assert.deepEqual(f.calls.pull, [f.receiptPath, f.actionPath, guestJournal]);
});

test('retained journal predating the capture permits bounded guest journal recovery', async t => {
 const f = await partialBefore(t);
 const guestJournal = join(f.state, 'journal/events.jsonl');
 await mkdir(dirname(guestJournal), { recursive: true });
 await writeFile(guestJournal, await readFile(f.journalPath));
 await writeFile(f.journalPath, JSON.stringify(f.journal[0]) + '\n');
 f.controls.offline = false;
 const result = await f.store.get({ ...target, phase: 'before' });
 assert.equal(result.status, 'attached', result.diagnostic ?? 'no diagnostic');
 assert.deepEqual(f.calls.pull, [guestJournal]);
});

test('before capture with missing reverse refs is recoverable from authoritative saved journal', async t => {
 const f = await partialBefore(t);
 const result = await f.store.get({ ...target, phase: 'before' });
 assert.equal(result.status, 'attached', result.diagnostic ?? 'no diagnostic');
 assert.equal(result.image!.phase, 'before'); assert.equal(result.image!.sha256, hash(original));
 assert.deepEqual(f.calls, { exec: [], pull: [], ensure: 0, push: 0 });
});

for (const change of ['hash', 'execution', 'duplicate', 'contradictory-reverse', 'reversed-order'] as const) test(`partial capture rejects ${change} in retained authoritative evidence`, async t => {
 const f = await partialBefore(t);
 const journal: any[] = structuredClone(f.journal);
 if (change === 'hash') journal[1].snapshot.sha256 = '0'.repeat(64);
 if (change === 'execution') journal[0].executionId = 'foreign';
 if (change === 'duplicate') journal.push(journal[1]);
 if (change === 'reversed-order') journal.reverse();
 if (change === 'contradictory-reverse') await jsonFile(join(f.hostRoot, 'state/records/action', `${f.sn.actionId}.json`), {
  ...f.action, snapshots: [{ ...journal[1].snapshot, role: 'after' }],
 });
 await writeFile(f.journalPath, journal.map(e => JSON.stringify(e)).join('\n') + '\n');
 assert.equal((await f.store.get({ ...target, phase: 'before' })).status, 'integrity-failed');
 assert.deepEqual(f.calls, { exec: [], pull: [], ensure: 0, push: 0 });
});

test('materialization copies only display originals to canonical state and preserves bytes on conflict', async t => {
 const f = await setup(t), first = await f.store.get(target);
 assert.equal(first.status, 'attached', first.diagnostic ?? 'no diagnostic');
 assert.equal((await f.store.get({ source: 'application', name: 'single' })).status, 'attached');
 const counts = structuredClone(f.calls); f.controls.offline = true;
 assert.equal(await f.store.materializeDisplayOriginals(f.hostRoot), 1);
 const path = join(f.hostRoot, 'state/snapshots', target.sessionId, f.snapshot.fileName);
 assert.deepEqual(await readFile(path), original);
 assert.equal(await f.store.materializeDisplayOriginals(f.hostRoot), 0);
 assert.deepEqual(await readdir(dirname(path)), [f.snapshot.fileName]);
 const conflict = Buffer.from(original); conflict[conflict.length - 1] ^= 1;
 await writeFile(path, conflict);
 await assert.rejects(f.store.materializeDisplayOriginals(f.hostRoot), { code: 'integrity-failed' });
 assert.deepEqual(await readFile(path), conflict); assert.deepEqual(f.calls, counts);
});

test('materialization checks ownership, skips untransferred references and does not contact guest', async t => {
 const f = await setup(t); f.controls.failImagePull = true;
 const first = await f.store.get(target);
 assert.equal(first.status, 'transfer-failed'); assert.ok(first.image);
 const counts = structuredClone(f.calls);
 assert.equal(await f.store.materializeDisplayOriginals(f.hostRoot), 0);
 await assert.rejects(f.store.materializeDisplayOriginals(join(f.root, 'foreign')), { code: 'unauthorized-reference' });
 await assert.rejects(new ImageStore({ ...f.options, owner: 'other' }).materializeDisplayOriginals(f.hostRoot), { code: 'unauthorized-reference' });
 assert.deepEqual(f.calls, counts);
});

test('expired deadline and cancellation reject before metadata effects', async t => {
 const f = await setup(t);
 const expired = await f.store.get(target, undefined, Date.now() - 1);
 assert.equal(expired.status, 'transfer-failed');
 const aborted = await f.store.get(target, AbortSignal.abort());
 assert.equal(aborted.status, 'transfer-failed');
 assert.deepEqual(f.calls, { exec: [], pull: [], ensure: 0, push: 0 });
});

test('caller deadline bounds a guest-readiness implementation that ignores cancellation', async t => {
 const f = await setup(t);
 // A live timer keeps this fixture running while AbortSignal.timeout is unrefed.
 const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
 const store = new ImageStore({ ...f.options, ensureGuest: async () => new Promise(() => {}) });
 const result = await store.get({ source: 'application', name: 'single' }, undefined, Date.now() + 25);
 assert.equal(result.status, 'transfer-failed'); assert.equal(result.image, undefined);
 assert.deepEqual(f.calls, { exec: [], pull: [], ensure: 0, push: 0 });
});
