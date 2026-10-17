import { imageFailure, type ImageDescriptor, type ImageResult } from './images.js';
import type { ArchiveEntry } from './archive.js';

/**
 * The background download queue of one guest (docs/screenshot-delivery.md
 * §10, AD-2 to AD-5). One worker takes the step downloads in order,
 * outside the manager's serialized section and inside the process that holds
 * the owner lock. Lifecycle operations drain it; shutdown closes it.
 */
export type DownloadState = 'open' | 'closing' | 'closed';
export type DownloadEnd = 'downloaded' | 'failed' | 'cancelled' | 'coalesced';
/** A step download's result: its after-image delivery, and the step files it brought into the step folder (AD-7). */
export interface StepResult extends ImageResult { files?: ArchiveEntry[]; missing?: string[] }
export interface DownloadJob {
  /** `<sessionId>/<executionId>`. */
  key: string;
  /** The identity the run result named, when the host knew it (AD-1). */
  image?: ImageDescriptor;
  /** Where the job's record is written when it ends. */
  recordPath: string;
  queuedAt: string; startedAt?: string; endedAt?: string;
  end?: DownloadEnd;
  result?: StepResult;
  /** Resolves once the job has ended and its record is written. */
  readonly done: Promise<void>;
}
interface Job extends DownloadJob {
  /** `relay_image` asked for it: it runs next, even while the worker is paused. */
  promoted?: boolean;
  run: (signal: AbortSignal) => Promise<StepResult>;
  resolve: () => void;
  controller: AbortController;
}
export interface DownloadQueueOptions {
  /** Downloads a run may leave queued before it waits for the oldest (DC-4). */
  bound: number;
  /** Writes the job's record. Not called once the queue is closed. */
  record: (job: DownloadJob) => Promise<void>;
}
/** A failure that copying the same original again might fix: the guest or the channel was not reachable in time. */
const transient = (job: Job) => job.result?.status === 'transfer-failed' && !job.controller.signal.aborted;

export class DownloadQueue {
  state: DownloadState = 'open';
  /** Set after a transient failure: the worker takes nothing until a relay operation reaches the guest (AD-4). */
  paused = false;
  private queued: Job[] = [];
  private current?: Job;
  private ended = { downloaded: 0, failed: 0, cancelled: 0, coalesced: 0 };
  constructor(readonly options: DownloadQueueOptions) {}

  enqueue(input: Pick<DownloadJob, 'key' | 'image' | 'recordPath'>, run: Job['run']): DownloadJob {
    if (this.state !== 'open') throw new Error(`The download queue is ${this.state}`);
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const job: Job = { ...input, queuedAt: new Date().toISOString(), done, run, resolve, controller: new AbortController() };
    this.queued.push(job); this.kick();
    return job;
  }
  /** The queued or in-flight job a reference or display selector names. */
  find(match: { imageId?: string; key?: string }): DownloadJob | undefined {
    return [this.current, ...this.queued].find(job => job && ((match.imageId && job.image?.imageId === match.imageId) || (match.key && job.key === match.key)));
  }
  /** `relay_image` asks for this job: it runs next, even while the worker is paused (AD-3). */
  promote(job: DownloadJob) {
    const index = this.queued.indexOf(job as Job);
    if (index < 0) return;
    (job as Job).promoted = true;
    if (index > 0) { this.queued.splice(index, 1); this.queued.unshift(job as Job); }
    this.kick();
  }
  /** Queued and in-flight downloads. */
  get pending() { return this.queued.length + (this.current ? 1 : 0); }
  counts() { return { queued: this.queued.length, inFlight: this.current ? 1 : 0, ...this.ended, paused: this.paused, state: this.state }; }
  /** A relay operation reached the guest and completed. */
  resume() { if (this.paused) { this.paused = false; this.kick(); } }
  /** AD-2: while over the bound, wait for the oldest download, unless the worker is paused. */
  async withinBound() {
    while (this.pending > this.options.bound && !this.paused && this.state === 'open') await (this.current ?? this.queued[0])!.done;
  }
  /**
   * AD-5: close to new downloads, end every download that has not started as
   * `coalesced` (DC-11), and wait for the one in flight. The lifecycle
   * operation fetches the coalesced steps' files in its own archive (AD-9).
   * Call `reopen` when the lifecycle operation ends.
   */
  async drain() {
    if (this.state === 'closed') return;
    this.state = 'closing'; this.paused = false;
    for (const job of this.queued.splice(0)) {
      job.end = 'coalesced'; job.endedAt = new Date().toISOString(); this.ended.coalesced++;
      await this.options.record(job).catch(() => {});
      job.resolve();
    }
    await this.current?.done;
  }
  reopen() { if (this.state === 'closing') { this.state = 'open'; this.kick(); } }
  /** Shutdown: nothing more starts or is written; the download in flight is aborted. `wait` waits for it to stop. */
  async close(wait: boolean) {
    this.state = 'closed';
    for (const job of this.queued.splice(0)) { job.end = 'cancelled'; job.resolve(); }
    const current = this.current;
    current?.controller.abort(new Error('The relay is shutting down'));
    if (wait) await current?.done;
  }
  private kick() {
    if (this.current || this.state === 'closed' || !this.queued.length || (this.paused && !this.queued[0].promoted)) return;
    void this.work(this.queued.shift()!);
  }
  private async work(job: Job) {
    this.current = job; job.startedAt = new Date().toISOString();
    try { job.result = await job.run(job.controller.signal); }
    catch (error) { job.result = imageFailure(error); }
    job.endedAt = new Date().toISOString();
    job.end = job.result.status === 'downloaded' ? 'downloaded' : 'failed';
    try {
      if (this.state !== 'closed') await this.options.record(job).catch(() => {});
      this.ended[job.end]++;
      // A download that reached the guest lifts a pause; a transient failure sets one (AD-4).
      if (job.end === 'downloaded') this.paused = false;
      else if (transient(job)) {
        if (this.state === 'closing') await this.cancelQueued();
        else if (this.state === 'open') this.paused = true;
      }
    } finally {
      this.current = undefined; job.resolve(); this.kick();
    }
  }
  /** DC-7: a lifecycle operation's state pull fetches these originals instead. */
  private async cancelQueued() {
    for (const job of this.queued.splice(0)) {
      job.end = 'cancelled'; job.endedAt = new Date().toISOString(); this.ended.cancelled++;
      await this.options.record(job).catch(() => {});
      job.resolve();
    }
  }
}
