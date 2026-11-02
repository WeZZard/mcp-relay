import { mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Build a folder whole, or not at all: `build` fills a new sibling of
 * `target` (on the same file system, so the swap is a rename), and only when
 * it succeeds does that folder replace `target`. A failed build leaves
 * `target` as it was and removes the partial one, then rethrows.
 */
export async function replaceOnSuccess(target, build) {
  const path = resolve(target);
  const staged = await mkdtemp(join(dirname(path), `.${basename(path)}-build-`));
  try {
    await build(staged);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  const old = `${staged}-old`;
  // Move the old folder aside first; put it back if the new one cannot go in.
  const hadOld = await rename(path, old).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  try {
    await rename(staged, path);
  } catch (error) {
    if (hadOld) await rename(old, path);
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
}
