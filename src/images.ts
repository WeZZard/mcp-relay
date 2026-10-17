import { mkdir, lstat, open, readdir, rm } from 'node:fs/promises';
import { constants, linkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transfer, assertHostPath } from './transfer.js';
import { hash, within } from './util.js';
import { prepareImage } from './image-presentation.js';
import { validateImageEvidence } from './guest/image-evidence.js';

export const imageCapability = { version: 1, action: 'image', sources: ['display', 'application', 'reference'], deadlineMs: 90000, transferAttempts: 3, recommendedRecoveryCalls: 2 } as const;
export type ImageTarget = { source: 'display'; sessionId: string; executionId: string; phase: 'before' | 'after' }
  | { source: 'application'; name: string; path?: string }
  | { source: 'reference'; imageId: string };
/** `pending` appears only in a run result and `downloaded` only in a background download's own result (docs/screenshot-delivery.md §10). */
export type ImageStatus = 'not-requested' | 'capture-failed' | 'capture-unknown' | 'unauthorized-reference' | 'unsafe-path' | 'image-missing' | 'stale-reference' | 'integrity-failed' | 'transfer-failed' | 'presentation-unavailable' | 'pending' | 'downloaded' | 'attached';
export interface ImageDescriptor {
  imageId: string; source: 'display' | 'application'; enclosure: string;
  sha256: string; bytes: number; mimeType: string;
  sessionId?: string; executionId?: string; actionId?: string; stepId?: string; phase?: 'before' | 'after'; capturedAt?: string; groupId?: string;
  name?: string; path?: string; retrievedAt?: string; originalPath?: string;
}
export interface ImageResult {
  status: ImageStatus; image?: ImageDescriptor; diagnostic?: string;
  presentation?: Awaited<ReturnType<typeof prepareImage>>['presentation'];
  content?: Awaited<ReturnType<typeof prepareImage>>['content'];
}
interface Recording { path: string; sessionId: string; guestState?: string }
interface StoredImage { descriptor: ImageDescriptor; fileName?: string; recording: string; remote: string; approvedRoot: string; local: string }
interface Operation { signal: AbortSignal; deadline: number; attemptBudget: { remaining: number }; retryDelaysMs?: readonly number[] }
export interface ImageStoreOptions {
  owner: string; enclosure: string; backend: unknown; catalogRoot: string;
  hostRoot: string; guestRoot: string; sessionId?: string; previousEvidence?: Recording[];
  declarations: Array<{ name: string; path: string }>; transfer: Transfer;
  ensureGuest: (signal: AbortSignal, deadline: number) => Promise<void>;
}
const MAX_METADATA = 4 * 1024 * 1024;
const MAX_IMAGE = 64 * 1024 * 1024;
const safeId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(s);
const safeCapture = (s: unknown): s is string => typeof s === 'string' && s.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/.test(s);
class ImageError extends Error { constructor(readonly code: ImageStatus, message: string) { super(message); } }
function fail(code: ImageStatus, message: string): never { throw new ImageError(code, message); }
const known = new Set<ImageStatus>(['not-requested', 'capture-failed', 'capture-unknown', 'unauthorized-reference', 'unsafe-path', 'image-missing', 'stale-reference', 'integrity-failed', 'transfer-failed', 'presentation-unavailable']);
export function imageFailure(error: unknown): ImageResult {
  const code = (error as { code?: ImageStatus })?.code;
  return { status: code && known.has(code) ? code : 'transfer-failed', diagnostic: error instanceof ImageError ? error.message : code && known.has(code) ? `Image operation failed: ${code}` : 'Image delivery could not complete; execution was not replayed.' };
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function guard(signal?: AbortSignal) { if (signal?.aborted) fail('transfer-failed', 'Image delivery cancelled or deadline exceeded.'); }
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  guard(signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new ImageError('transfer-failed', 'Image delivery cancelled or deadline exceeded.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { const result = await Promise.race([operation(), cancelled]); guard(signal); return result; }
  finally { signal.removeEventListener('abort', abort); }
}
async function hostPath(root: string, path: string, missing = false) {
  try { await assertHostPath(root, path, missing); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    fail('unsafe-path', 'Image storage path is unsafe.');
  }
}
async function readBounded(root: string, path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  guard(signal); await hostPath(root, path);
  const before = await lstat(path);
  if (!before.isFile()) fail('unsafe-path', 'Image evidence must be a regular file.');
  if (before.size < 1 || before.size > limit) fail('integrity-failed', 'Image evidence exceeds its size bound.');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (s: typeof before) => s.isFile() && s.dev === before.dev && s.ino === before.ino && s.size === before.size && s.mtimeMs === before.mtimeMs && s.ctimeMs === before.ctimeMs;
    if (!same(await fd.stat())) fail('integrity-failed', 'Image evidence changed before reading.');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      guard(signal);
      const part = await fd.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== before.size || !same(await fd.stat())) fail('integrity-failed', 'Image evidence changed while reading.');
    await hostPath(root, path);
    if (!same(await lstat(path))) fail('integrity-failed', 'Image evidence changed after reading.');
    guard(signal); return bytes.subarray(0, length);
  } finally { await fd.close(); }
}
function parseMetadata(bytes: Buffer): any {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('integrity-failed', 'Invalid saved image metadata.'); }
}
async function readMetadata(root: string, path: string, signal?: AbortSignal) { return parseMetadata(await readBounded(root, path, MAX_METADATA, signal)); }
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
// Publish only complete, fsynced files. A conflict never replaces existing bytes.
async function publish(root: string, path: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  guard(signal); await hostPath(root, path, true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await hostPath(root, path, true); guard(signal);
  const temporary = join(dirname(path), `.image-${randomUUID()}.tmp`);
  const fd = await open(temporary, 'wx', 0o600);
  try {
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    await hostPath(root, temporary); await hostPath(root, path, true); guard(signal);
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readBounded(root, path, Math.max(MAX_METADATA, bytes.length), signal)).equals(bytes)) fail('integrity-failed', 'Existing image evidence conflicts with its immutable identity.');
    }
  } finally {
    await hostPath(root, temporary, true); await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  guard(signal);
}
function verifyOriginal(bytes: Buffer, descriptor: ImageDescriptor) {
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) fail('integrity-failed', 'Original bytes conflict with their image reference.');
}

/** Where a step download put a guest state file (AD-7): `host/steps/<executionId>/state/...`. */
const stepCopy = (recording: string, executionId: string, ...relative: string[]) => join(recording, 'host', 'steps', executionId, 'state', ...relative);

export class ImageStore {
  constructor(readonly options: ImageStoreOptions) {}
  private get binding() { const o = this.options; return hash(JSON.stringify([o.owner, o.enclosure, o.backend])); }
  private get recordings(): Recording[] { const o = this.options; return [...(o.previousEvidence ?? []), ...(o.sessionId ? [{ path: o.hostRoot, sessionId: o.sessionId, guestState: join(o.guestRoot, 'state') }] : [])]; }
  private identity(descriptor: Omit<ImageDescriptor, 'imageId'>, fileName?: string) { return `image-${hash(canonical([this.binding, descriptor, fileName ?? null]))}`; }
  private async load(id: string, signal?: AbortSignal): Promise<StoredImage> {
    if (!/^image-[a-f0-9]{64}$/.test(id)) fail('unauthorized-reference', 'Image reference is not authorized for this enclosure.');
    const record = await optional(() => readMetadata(this.options.catalogRoot, join(this.options.catalogRoot, `${id}.json`), signal));
    if (!record || record.binding !== this.binding || record.descriptor?.imageId !== id || record.descriptor?.enclosure !== this.options.enclosure) fail('unauthorized-reference', 'Image reference is not authorized for this enclosure.');
    if (Object.keys(record).some(k => !['binding', 'descriptor', 'fileName', 'recording', 'remote', 'approvedRoot', 'local'].includes(k))) fail('integrity-failed', 'Invalid image catalogue schema.');
    const d = record.descriptor;
    const allowed = ['imageId', 'source', 'enclosure', 'sha256', 'bytes', 'mimeType', ...(d.source === 'display' ? ['sessionId', 'executionId', 'actionId', 'stepId', 'phase', 'capturedAt', 'groupId'] : ['name', 'path'])];
    if (Object.keys(d).some(k => !allowed.includes(k)) || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > MAX_IMAGE || !['image/png', 'image/jpeg', 'image/webp'].includes(d.mimeType)) fail('integrity-failed', 'Stored image integrity metadata is invalid.');
    const { imageId: _id, ...descriptor } = d;
    if (this.identity(descriptor, record.fileName) !== id) fail('integrity-failed', 'Image catalogue identity has changed.');
    const root = [this.options.hostRoot, ...this.recordings.map(r => r.path)].find(p => p === record.recording);
    if (!root || record.local !== join(root, 'host', 'images', id, `original${extension(d.mimeType)}`)) fail('integrity-failed', 'Stored image association is invalid.');
    if (d.source === 'application') {
      if (record.fileName !== undefined || typeof d.name !== 'string' || (d.path !== undefined && typeof d.path !== 'string')) fail('integrity-failed', 'Stored application identity is invalid.');
      const declaration = this.options.declarations.find(item => item.name === d.name);
      if (!declaration) fail('unauthorized-reference', 'Application image declaration is unavailable.');
      let remote: string;
      try { const declared = within(join(this.options.guestRoot, 'workspace'), declaration.path); remote = d.path === undefined ? declared : within(declared, d.path); }
      catch { fail('integrity-failed', 'Stored application selection is invalid.'); }
      if (record.remote !== remote || record.approvedRoot !== join(this.options.guestRoot, 'workspace')) fail('integrity-failed', 'Stored application selection is invalid.');
    } else if (d.source === 'display') {
      const recording = this.recordings.find(r => r.sessionId === d.sessionId && r.path === root);
      if (!recording || !safeId(d.sessionId) || !safeId(d.executionId) || !safeId(d.actionId) || (d.stepId !== undefined && !safeId(d.stepId)) || (d.groupId !== undefined && !safeId(d.groupId)) || !['before', 'after'].includes(d.phase) || typeof d.capturedAt !== 'string' || !Number.isFinite(Date.parse(d.capturedAt)) || d.mimeType !== 'image/png' || !safeCapture(record.fileName)) fail('integrity-failed', 'Stored display identity is invalid.');
      const originalState = join(this.options.guestRoot, 'state');
      if (![originalState, recording.guestState].filter(Boolean).includes(record.approvedRoot) || record.remote !== join(record.approvedRoot, 'snapshots', recording.sessionId, record.fileName)) fail('integrity-failed', 'Stored display path is invalid.');
      if (recording.guestState) {
        record.approvedRoot = recording.guestState;
        record.remote = join(recording.guestState, 'snapshots', recording.sessionId, record.fileName);
      }
    } else fail('integrity-failed', 'Unknown image source.');
    return record;
  }
  private async register(descriptor: Omit<ImageDescriptor, 'imageId'>, recording: string, remote: string, approvedRoot: string, options: Operation, fileName?: string): Promise<StoredImage> {
    const imageId = this.identity(descriptor, fileName);
    // Existing entries are validated rather than replaced, including after resets.
    const existing = await optional(() => readBounded(this.options.catalogRoot, join(this.options.catalogRoot, `${imageId}.json`), MAX_METADATA, options.signal));
    if (existing) return this.load(imageId, options.signal);
    const record: StoredImage = { descriptor: { ...descriptor, imageId }, ...(fileName ? { fileName } : {}), recording, remote, approvedRoot, local: join(recording, 'host', 'images', imageId, `original${extension(descriptor.mimeType)}`) };
    await publish(this.options.catalogRoot, join(this.options.catalogRoot, `${imageId}.json`), Buffer.from(canonical({ ...record, binding: this.binding })), options.signal);
    return record;
  }
  private async metadata(relative: string, recording: Recording, options: Operation, extraPaths: string[] = [], hostOnly = false): Promise<any> {
    const cached = join(recording.path, 'host', 'image-evidence', relative);
    let local: any;
    for (const path of [...extraPaths, join(recording.path, 'state', relative), cached]) {
      const value = await optional(() => readMetadata(recording.path, path, options.signal));
      if (value !== undefined) {
        if (local !== undefined && canonical(local) !== canonical(value)) fail('integrity-failed', 'Retained image metadata conflicts.');
        local = value;
      }
    }
    if (local !== undefined) return local;
    if (hostOnly) return undefined;
    if (!recording.guestState) fail('capture-unknown', 'This recording has no available retained metadata or supported guest evidence location.');
    await this.options.ensureGuest(options.signal, options.deadline); guard(options.signal);
    const path = join(recording.path, 'host', 'image-metadata', randomUUID(), 'metadata.json');
    const bytes = await this.options.transfer.pullImageMetadata(join(recording.guestState, relative), path, recording.guestState, recording.path, options);
    guard(options.signal);
    if (bytes.length > MAX_METADATA) fail('integrity-failed', 'Image metadata exceeds its bound.');
    const value = parseMetadata(bytes);
    await publish(recording.path, cached, Buffer.from(canonical(value)), options.signal);
    return value;
  }
  private journalCorroborates(bytes: Buffer, request: any, sn: any): boolean {
    let events: any[];
    try { events = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(s => s.trim()).map(s => JSON.parse(s)); }
    catch { fail('integrity-failed', 'Invalid retained capture journal.'); }
    if (events.some(e => !e || typeof e !== 'object' || Array.isArray(e))) fail('integrity-failed', 'Invalid retained capture journal event.');
    const starts = events.filter(e => e.kind === 'action-start' && e.actionId === sn.actionId);
    const captures = events.filter(e => e.kind === 'snapshot-captured' && ((e.actionId === sn.actionId && e.snapshot?.role === sn.phase) || e.snapshot?.fileName === sn.fileName));
    const start = starts[0], capture = captures[0];
    const plan = start?.snapshotPlan;
    if (starts.length > 1 || (start && (start.sessionId !== request.sessionId || start.attemptId !== request.attemptId || start.executionId !== request.executionId || start.stepId !== request.step?.id || plan?.group?.groupId !== request.snapshots?.group?.groupId || !(sn.phase === 'before' ? plan?.capturesBefore === true : plan?.capturesAfter?.afterIntervalMs === sn.declaredAfterIntervalMs)))) fail('integrity-failed', 'Saved action journal contradicts the image.');
    for (const event of events.filter(e => e.kind === 'snapshot-evidence' && e.actionId === sn.actionId)) this.checkReferences(event.snapshots, sn);
    // A retained state tree can predate this execution. Absence is not a contradiction.
    if (!captures.length) return false;
    if (starts.length !== 1 || captures.length !== 1 || capture.actionId !== sn.actionId || capture.sessionId !== request.sessionId || capture.attemptId !== request.attemptId || capture.group !== request.snapshots?.group?.groupId || events.indexOf(start) >= events.indexOf(capture) || !sameSnapshot(capture.snapshot, sn)) fail('integrity-failed', 'Saved capture journal does not corroborate the image.');
    const completions = events.filter(e => e.kind === 'action-completion' && e.actionId === sn.actionId);
    if (completions.some(e => events.indexOf(e) <= events.indexOf(capture))) fail('integrity-failed', 'Saved capture is outside its action interval.');
    return true;
  }
  private async corroborateJournal(recording: Recording, request: any, sn: any, options: Operation) {
    const cached = join(recording.path, 'host', 'image-evidence', 'journals', `${sn.actionId}.jsonl`);
    let corroborated = false;
    for (const path of [join(recording.path, 'state', 'journal', 'events.jsonl'), cached]) {
      const bytes = await optional(() => readBounded(recording.path, path, MAX_METADATA, options.signal));
      if (bytes && this.journalCorroborates(bytes, request, sn)) corroborated = true;
    }
    if (corroborated) return;
    if (!recording.guestState) fail('integrity-failed', 'Missing reverse references have no available corroborating capture journal.');
    await this.options.ensureGuest(options.signal, options.deadline); guard(options.signal);
    const local = join(recording.path, 'host', 'image-metadata', randomUUID(), 'journal.jsonl');
    let bytes: Buffer;
    try {
      bytes = await this.options.transfer.pullImageMetadata(join(recording.guestState, 'journal', 'events.jsonl'), local, recording.guestState, recording.path, { ...options, metadataFormat: 'jsonl' });
    } catch (error) {
      if ((error as { code?: string }).code === 'image-missing') fail('integrity-failed', 'Missing reverse references have no authoritative capture journal.');
      throw error;
    }
    guard(options.signal);
    if (bytes.length > MAX_METADATA || !this.journalCorroborates(bytes, request, sn)) fail('integrity-failed', 'Saved capture journal does not establish the selected image.');
    await publish(recording.path, cached, bytes, options.signal);
  }
  private checkReferences(snapshots: any, sn: any): boolean {
    if (snapshots === undefined) return false;
    if (!Array.isArray(snapshots)) fail('integrity-failed', 'Saved reverse snapshot references are invalid.');
    const matches = snapshots.filter((s: any) => s?.role === sn.phase || s?.fileName === sn.fileName);
    if (matches.length > 1 || (matches.length === 1 && !sameSnapshot(matches[0], sn))) fail('integrity-failed', 'Saved reverse snapshot reference contradicts the capture.');
    return matches.length === 1;
  }
  /** The saved capture a display selector names, from the request and the receipt. With `hostOnly`, no guest I/O: undefined when the receipt is not on the host. */
  private async displaySelection(target: Extract<ImageTarget, { source: 'display' }>, options: Operation, hostOnly = false): Promise<{ recording: Recording; request: any; sn: any } | ImageResult | undefined> {
    if (!safeId(target.sessionId) || !safeId(target.executionId) || !['before', 'after'].includes(target.phase)) fail('unauthorized-reference', 'Invalid display identity.');
    const recording = this.recordings.find(r => r.sessionId === target.sessionId);
    if (!recording) fail('unauthorized-reference', 'Recording does not belong to this enclosure.');
    const request = await optional(() => readMetadata(recording.path, join(recording.path, 'host', 'requests', `${target.executionId}.json`), options.signal));
    if (!request) fail('unauthorized-reference', 'Execution does not belong to this enclosure.');
    if (request.sessionId !== target.sessionId || request.executionId !== target.executionId) fail('integrity-failed', 'Execution identity does not match its recording.');
    if (request.capture === false) return { status: 'not-requested', diagnostic: 'The image lists no capture software (cua-driver), so this run took no snapshots.' };
    const group = request.snapshots?.group;
    const requested = !request.diagnostic && (target.phase === 'before' ? !group || group.phase === 'first' : !group || group.phase === 'last');
    if (!requested) return { status: 'not-requested', diagnostic: 'The declared snapshot plan does not capture this phase.' };
    const receipt = await this.metadata(join('receiver', 'receipts', `${target.executionId}.json`), recording, options, [join(recording.path, 'host', 'receiver-receipts', `${target.executionId}.json`), stepCopy(recording.path, target.executionId, 'receiver', 'receipts', `${target.executionId}.json`)], hostOnly);
    if (receipt === undefined) return undefined;
    if (receipt?.executionId !== request.executionId) fail('integrity-failed', 'Receipt execution identity mismatch.');
    const evidence = receipt.imageEvidence;
    if (!evidence) return { status: 'capture-unknown', diagnostic: 'Recording predates saved-image descriptors; no input was replayed.' };
    try { validateImageEvidence(evidence, request); } catch { fail('integrity-failed', 'Saved image evidence does not match its request.'); }
    const matches = evidence.snapshots.filter((s: any) => s.phase === target.phase);
    if (!matches.length) return { status: evidence.status === 'capture-failed' ? 'capture-failed' : 'capture-unknown', diagnostic: 'No saved image is established for the requested phase.' };
    return { recording, request, sn: matches[0] };
  }
  private displayDescriptor(sn: any): Omit<ImageDescriptor, 'imageId'> {
    return { source: 'display', enclosure: this.options.enclosure, sessionId: sn.sessionId, executionId: sn.executionId, actionId: sn.actionId, ...(sn.stepId ? { stepId: sn.stepId } : {}), phase: sn.phase, capturedAt: sn.capturedAt, ...(sn.groupId ? { groupId: sn.groupId } : {}), sha256: sn.sha256, bytes: sn.bytes, mimeType: sn.mimeType };
  }
  private async display(target: Extract<ImageTarget, { source: 'display' }>, options: Operation): Promise<StoredImage | ImageResult> {
    const selected = await this.displaySelection(target, options);
    if (!selected || 'status' in selected) return selected ?? fail('capture-unknown', 'No saved receipt is available.');
    const { recording, request, sn } = selected;
    const group = request.snapshots?.group;
    let action: any;
    try { action = await this.metadata(join('records', 'action', `${sn.actionId}.json`), recording, options, [stepCopy(recording.path, sn.executionId, 'records', 'action', `${sn.actionId}.json`)]); }
    catch (error) { if ((error as { code?: string }).code === 'image-missing') fail('integrity-failed', 'Receipt cites a missing authoritative action.'); throw error; }
    if (!action || action.actionId !== sn.actionId || action.sessionId !== request.sessionId || action.executionId !== request.executionId || action.attemptId !== request.attemptId || action.groupId !== group?.groupId || action.stepId !== request.step?.id || (action.snapshotRole !== undefined && action.snapshotRole !== (group?.phase ?? 'single'))) fail('integrity-failed', 'Saved action identity does not corroborate the image.');
    if (!this.checkReferences(action.snapshots, sn)) await this.corroborateJournal(recording, request, sn, options);
    const descriptor = this.displayDescriptor(sn);
    const state = recording.guestState ?? join(this.options.guestRoot, 'state');
    return this.register(descriptor, recording.path, join(state, 'snapshots', recording.sessionId, sn.fileName), state, options, sn.fileName);
  }
  private async application(target: Extract<ImageTarget, { source: 'application' }>, options: Operation): Promise<StoredImage> {
    const declaration = this.options.declarations.find(d => d.name === target.name);
    if (!declaration) fail('unauthorized-reference', 'Application image is not declared.');
    const root = join(this.options.guestRoot, 'workspace');
    let remote: string;
    try { const declared = within(root, declaration.path); remote = target.path === undefined ? declared : within(declared, target.path); }
    catch { return fail('unsafe-path', 'Application image requires a confined relative path.'); }
    const mimeType = mime(remote);
    await this.options.ensureGuest(options.signal, options.deadline); guard(options.signal);
    const fact = await this.options.transfer.imageFact(remote, root, options);
    return this.register({ source: 'application', enclosure: this.options.enclosure, name: target.name, ...(target.path === undefined ? {} : { path: target.path }), sha256: fact.sha256, bytes: fact.bytes, mimeType }, this.options.hostRoot, remote, root, options);
  }
  private async original(record: StoredImage, options: Operation): Promise<Buffer> {
    let bytes = await optional(() => readBounded(record.recording, record.local, MAX_IMAGE, options.signal));
    if (bytes) { verifyOriginal(bytes, record.descriptor); return bytes; }
    if (record.descriptor.source === 'display') {
      // The recording's state, then the step download's folder (AD-3), before the guest.
      for (const path of [join(record.recording, 'state', 'snapshots', record.descriptor.sessionId!, record.fileName!), stepCopy(record.recording, record.descriptor.executionId!, 'snapshots', record.descriptor.sessionId!, record.fileName!)]) {
        bytes = await optional(() => readBounded(record.recording, path, MAX_IMAGE, options.signal));
        if (bytes) { verifyOriginal(bytes, record.descriptor); await publish(record.recording, record.local, bytes, options.signal); return bytes; }
      }
      if (!this.recordings.find(r => r.path === record.recording && r.sessionId === record.descriptor.sessionId)?.guestState) fail('stale-reference', 'The original is unavailable in retained host evidence and its guest recording is no longer addressable.');
    }
    await this.options.ensureGuest(options.signal, options.deadline); guard(options.signal);
    return this.options.transfer.pullImage(record.remote, record.local, record.approvedRoot, record.recording, record.descriptor, options);
  }
  /**
   * A run's after-image as `pending`: its identity from the request and the
   * receipt on the host, with no guest I/O (docs/screenshot-delivery.md §10,
   * AD-1). Without the receipt on the host it is `pending` with no identity.
   */
  async pending(target: Extract<ImageTarget, { source: 'display' }>): Promise<ImageResult> {
    const deadline = Date.now() + imageCapability.deadlineMs;
    const options: Operation = { signal: AbortSignal.timeout(imageCapability.deadlineMs), deadline, attemptBudget: { remaining: 0 } };
    try {
      const selected = await this.displaySelection(target, options, true);
      if (!selected) return { status: 'pending', diagnostic: 'The receipt is not on the host yet; retrieve the image with its display selector.' };
      if ('status' in selected) return selected;
      const descriptor = this.displayDescriptor(selected.sn);
      const imageId = this.identity(descriptor, selected.sn.fileName);
      return { status: 'pending', image: { ...descriptor, imageId, originalPath: join(selected.recording.path, 'host', 'images', imageId, `original${extension(descriptor.mimeType)}`) } };
    } catch (error) { return imageFailure(error); }
  }
  /** Retrieve and present one image: the `relay_image` delivery. */
  async get(target: ImageTarget, signal?: AbortSignal, requestedDeadline = Date.now() + imageCapability.deadlineMs): Promise<ImageResult> {
    return this.deliver(target, true, signal, requestedDeadline);
  }
  /** A background download (AD-2): the same checks and verified original as `get`, without the preview. */
  async download(target: ImageTarget, signal?: AbortSignal, options: { retryDelaysMs?: readonly number[] } = {}): Promise<ImageResult> {
    return this.deliver(target, false, signal, Date.now() + imageCapability.deadlineMs, options.retryDelaysMs);
  }
  private async deliver(target: ImageTarget, present: boolean, signal: AbortSignal | undefined, requestedDeadline: number, retryDelaysMs?: readonly number[]): Promise<ImageResult> {
    const deadline = Math.min(requestedDeadline, Date.now() + imageCapability.deadlineMs);
    if (!Number.isFinite(deadline)) return imageFailure(new ImageError('transfer-failed', 'Invalid image deadline.'));
    if (Date.now() >= deadline) return imageFailure(new ImageError('transfer-failed', 'Image delivery deadline exceeded.'));
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))), ...(signal ? [signal] : [])]);
    const options: Operation = { signal: boundedSignal, deadline, attemptBudget: { remaining: imageCapability.transferAttempts }, ...(retryDelaysMs ? { retryDelaysMs } : {}) };
    let record: StoredImage | undefined;
    try {
      return await bounded(async () => {
        const selected = target.source === 'reference' ? await this.load(target.imageId, boundedSignal) : target.source === 'display' ? await this.display(target, options) : await this.application(target, options);
        guard(boundedSignal);
        if ('status' in selected) return selected;
        record = selected;
        const bytes = await this.original(record, options); guard(boundedSignal);
        if (!present) {
          const image = { ...record.descriptor, originalPath: record.local };
          await publish(record.recording, join(record.recording, 'host', 'images', record.descriptor.imageId, `delivery-${randomUUID()}.json`), Buffer.from(canonical({ image, at: new Date().toISOString(), status: 'downloaded' })), boundedSignal);
          guard(boundedSignal);
          return { status: 'downloaded' as const, image };
        }
        const presentation = await bounded(() => prepareImage(bytes, record!.descriptor.mimeType), boundedSignal);
        const image = { ...record.descriptor, originalPath: record.local, ...(record.descriptor.source === 'application' ? { retrievedAt: new Date().toISOString() } : {}) };
        const receipt = { image, presentation: presentation.presentation, at: new Date().toISOString(), status: 'attached' };
        await publish(record.recording, join(record.recording, 'host', 'images', record.descriptor.imageId, `delivery-${randomUUID()}.json`), Buffer.from(canonical(receipt)), boundedSignal);
        guard(boundedSignal);
        return { status: 'attached' as const, image, ...presentation };
      }, boundedSignal);
    } catch (error) { return { ...imageFailure(error), ...(record ? { image: record.descriptor } : {}) }; }
  }
  /** Verified display originals this recording already holds on the host, by `sha256:bytes`; the finish's state pull copies them instead of pulling (AD-6). No guest I/O. */
  async heldOriginals(recordingRoot: string): Promise<Map<string, string[]>> {
    const held = new Map<string, string[]>();
    if (!this.recordings.some(r => r.path === recordingRoot)) return held;
    const names = await optional(() => readdir(this.options.catalogRoot)) ?? [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      // Reuse is an optimization: an entry that does not load is skipped here and reported by materializeDisplayOriginals.
      const record = await this.load(name.slice(0, -5)).catch(() => undefined);
      if (!record || record.recording !== recordingRoot || record.descriptor.source !== 'display') continue;
      const key = `${record.descriptor.sha256}:${record.descriptor.bytes}`;
      held.set(key, [...(held.get(key) ?? []), record.local]);
    }
    return held;
  }
  /** Call before merging incoming guest state. This method performs no guest I/O. */
  async materializeDisplayOriginals(recordingRoot: string): Promise<number> {
    if (!this.recordings.some(r => r.path === recordingRoot)) fail('unauthorized-reference', 'Recording does not belong to this enclosure.');
    await hostPath(this.options.catalogRoot, this.options.catalogRoot, true);
    const names = await optional(() => readdir(this.options.catalogRoot)) ?? [];
    const pending: Array<{ path: string; record: StoredImage }> = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const record = await this.load(name.slice(0, -5));
      if (record.recording !== recordingRoot || record.descriptor.source !== 'display') continue;
      const bytes = await optional(() => readBounded(record.recording, record.local, MAX_IMAGE));
      if (!bytes) continue;
      verifyOriginal(bytes, record.descriptor);
      const path = join(recordingRoot, 'state', 'snapshots', record.descriptor.sessionId!, record.fileName!);
      const existing = await optional(() => readBounded(recordingRoot, path, MAX_IMAGE));
      if (existing && !existing.equals(bytes)) fail('integrity-failed', 'Canonical snapshot conflicts with the delivered original.');
      if (!existing) pending.push({ path, record });
    }
    for (const { path, record } of pending) {
      const bytes = await readBounded(record.recording, record.local, MAX_IMAGE);
      verifyOriginal(bytes, record.descriptor);
      await publish(recordingRoot, path, bytes);
    }
    return pending.length;
  }
}
function sameSnapshot(s: any, sn: any): boolean {
  return !!s && s.fileName === sn.fileName && s.role === sn.phase && s.sha256 === sn.sha256 && s.bytes === sn.bytes && s.capturedAt === sn.capturedAt && s.declaredAfterIntervalMs === sn.declaredAfterIntervalMs;
}
function extension(type: string): string { return type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : fail('presentation-unavailable', 'Unsupported image format.'); }
function mime(path: string): string { const ext = extname(path).toLowerCase(); return ext === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : fail('presentation-unavailable', 'Only PNG, JPEG, and WebP images are supported.'); }
