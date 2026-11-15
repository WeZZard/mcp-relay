import { open, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { within } from './util.js';

/**
 * The relay's own uncompressed archive (AD-8): for each file, a JSON header
 * line `{"path","bytes"}`, exactly that many bytes, then a JSON line
 * `{"sha256"}` of those bytes. The guest reads each file once to check, hash
 * and write it; PNG originals do not compress further.
 */
export interface ArchiveEntry { path: string; bytes: number; sha256: string }

const MAX_LINE_BYTES = 64 * 1024;

const header = (path: string, bytes: number) => `${JSON.stringify({ path, bytes })}\n`;
const trailer = (sha256: string) => `${JSON.stringify({ sha256 })}\n`;
/** The exact archive size the guest must report for these files. */
export function archiveBytes(files: readonly ArchiveEntry[]): number {
  return files.reduce((sum, file) => sum + Buffer.byteLength(header(file.path, file.bytes)) + file.bytes + Buffer.byteLength(trailer(file.sha256)), 0);
}

/** Split a request so each guest command's path arguments stay within `maxArgvBytes`; `argvBytes` is what one file adds. */
export function archiveChunks<T extends { path: string }>(files: readonly T[], maxArgvBytes = 64 * 1024, argvBytes = (file: T) => Buffer.byteLength(file.path) + 1): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [], size = 0;
  for (const file of files) {
    const bytes = argvBytes(file);
    if (chunk.length && size + bytes > maxArgvBytes) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(file); size += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** The host source of a push changed or is not safe to read: the stage is refused, never retried per file (AD-11). */
export class StagingSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'StagingSourceError'; }
}

/** A host file to pack: `source` is where its bytes are, `path` its relative path in the archive. */
export interface PackEntry extends ArchiveEntry { source: string }

/**
 * Write the host files into a new archive at `archive`, in the format above, for the push of a
 * workspace (AD-11). Each file is opened without following a link and must still have the size and
 * hash of the inventory, or the pack fails with `Staging source changed`. `beforeOpen` checks each
 * source's path first. Returns the archive's size and SHA-256 and each file's permission bits.
 */
export async function packArchive(archive: string, files: readonly PackEntry[], beforeOpen: (source: string) => Promise<void> = async () => {}): Promise<{ bytes: number; sha256: string; modes: number[] }> {
  const output = await open(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const whole = createHash('sha256'), modes: number[] = [];
  let total = 0;
  const put = async (bytes: Buffer) => {
    whole.update(bytes); total += bytes.length;
    for (let written = 0; written < bytes.length;) written += (await output.write(bytes, written, bytes.length - written)).bytesWritten;
  };
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    // A failure of a source is a StagingSourceError; a failure to write the archive is not, so the push may fall back.
    const source = async <T>(file: PackEntry, step: () => Promise<T>): Promise<T> => {
      try { return await step(); }
      catch (error) { throw error instanceof StagingSourceError ? error : new StagingSourceError(`Staging source changed: ${file.source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    };
    for (const file of files) {
      const input = await source(file, async () => { await beforeOpen(file.source); return open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW); });
      try {
        const info = await source(file, () => input.stat());
        if (!info.isFile() || info.size !== file.bytes) throw new StagingSourceError(`Staging source changed: ${file.source}`);
        modes.push(info.mode & 0o777);
        await put(Buffer.from(header(file.path, file.bytes)));
        const digest = createHash('sha256');
        let read = 0;
        for (;;) {
          const { bytesRead } = await source(file, () => input.read(buffer, 0, buffer.length, null));
          if (!bytesRead) break;
          read += bytesRead;
          if (read > file.bytes) break;
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk); await put(chunk);
        }
        if (read !== file.bytes || digest.digest('hex') !== file.sha256) throw new StagingSourceError(`Staging source changed: ${file.source}`);
        await put(Buffer.from(trailer(file.sha256)));
      } finally { await input.close(); }
    }
  } finally { await output.close(); }
  return { bytes: total, sha256: whole.digest('hex'), modes };
}

/** A requested file; a step's download knows neither size nor hash before the archive arrives. */
export interface ArchiveRequest { path: string; bytes?: number; sha256?: string }

/**
 * Unpack an archive into a fresh `directory`. It must hold the requested files
 * in order, each with the requested size and hash when known, and end right
 * after the last one. With `skipMissing`, a requested file may be absent, as
 * when the guest left out a file it does not hold. Every path is relative and
 * traversal-free. Returns the unpacked files.
 */
export async function unpackArchive(archive: string, directory: string, requested: readonly ArchiveRequest[], options: { skipMissing?: boolean } = {}): Promise<ArchiveEntry[]> {
  const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  const unpacked: ArchiveEntry[] = [];
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let start = 0, end = 0, eof = false;
    const fill = async () => {
      if (start > 0) { buffer.copy(buffer, 0, start, end); end -= start; start = 0; }
      const { bytesRead } = await input.read(buffer, end, buffer.length - end, null);
      if (!bytesRead) eof = true;
      end += bytesRead;
    };
    const atEnd = async () => { if (start === end && !eof) await fill(); return start === end; };
    const line = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const at = buffer.indexOf(10, start);
        if (at >= 0 && at < end) {
          const text = buffer.toString('utf8', start, at); start = at + 1;
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive line');
          return value as Record<string, unknown>;
        }
        if (end - start > MAX_LINE_BYTES) throw new Error('Archive line too long');
        if (eof) throw new Error('Archive truncated');
        await fill();
      }
    };
    let next = 0;
    while (next < requested.length) {
      if (options.skipMissing && await atEnd()) break;
      const head = await line();
      // Entries come in the requested order; with skipMissing, earlier requests may be absent.
      let index = requested.findIndex((file, at) => at >= next && file.path === head.path);
      if (index < 0 || (!options.skipMissing && index !== next)) throw new Error(`Unexpected archive entry: ${String(head.path)}`);
      const fact = requested[index]; next = index + 1;
      if (!Number.isSafeInteger(head.bytes) || (head.bytes as number) < 0 || (fact.bytes !== undefined && head.bytes !== fact.bytes) || Object.keys(head).length !== 2) throw new Error(`Unexpected archive entry: ${fact.path}`);
      const bytes = head.bytes as number;
      const target = within(directory, fact.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const digest = createHash('sha256');
      try {
        for (let left = bytes; left > 0;) {
          if (start === end) {
            if (eof) throw new Error('Archive truncated');
            await fill(); continue;
          }
          const chunk = buffer.subarray(start, start + Math.min(left, end - start));
          digest.update(chunk);
          for (let written = 0; written < chunk.length;) written += (await output.write(chunk, written, chunk.length - written)).bytesWritten;
          start += chunk.length; left -= chunk.length;
        }
      } finally { await output.close(); }
      const sha256 = digest.digest('hex'), tail = await line();
      if (tail.sha256 !== sha256 || Object.keys(tail).length !== 1) throw new Error(`Archive entry checksum mismatch: ${fact.path}`);
      if (fact.sha256 !== undefined && sha256 !== fact.sha256) throw new Error(`Extraction checksum mismatch: ${fact.path}`);
      unpacked.push({ path: fact.path, bytes, sha256 });
    }
    if (!await atEnd()) throw new Error('Archive has trailing bytes');
    return unpacked;
  } finally { await input.close(); }
}
