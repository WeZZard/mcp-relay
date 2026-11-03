/**
 * The build replaces dist/ only when it succeeds: a failed build, such as one
 * with a dependency missing, leaves the committed dist/ as it was.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { replaceOnSuccess } from '../scripts/replace-on-success.mjs';
import { childEnvironment } from './isolation.js';

const root = resolve(import.meta.dirname, '..');
function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-relay-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const seed = (dir: string) => { mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist', 'server.mjs'), 'the committed build'); };

test('a build that fails leaves the folder as it was and nothing beside it', async t => {
  const dir = scratch(t);
  seed(dir);
  await assert.rejects(replaceOnSuccess(join(dir, 'dist'), async (out: string) => {
    writeFileSync(join(out, 'server.mjs'), 'half');
    throw new Error('Could not resolve "@wezzard/relay-driver-core"');
  }), /Could not resolve/);
  assert.equal(readFileSync(join(dir, 'dist', 'server.mjs'), 'utf8'), 'the committed build');
  assert.deepEqual(readdirSync(dir), ['dist']);
});

test('a build that succeeds replaces the folder whole, and builds one that was absent', async t => {
  const dir = scratch(t);
  seed(dir);
  writeFileSync(join(dir, 'dist', 'stale.mjs'), 'from an older build');
  await replaceOnSuccess(join(dir, 'dist'), async (out: string) => { writeFileSync(join(out, 'server.mjs'), 'new'); });
  assert.deepEqual(readdirSync(join(dir, 'dist')), ['server.mjs'], 'nothing stale is kept');
  assert.equal(readFileSync(join(dir, 'dist', 'server.mjs'), 'utf8'), 'new');
  assert.deepEqual(readdirSync(dir), ['dist']);
  await replaceOnSuccess(join(dir, 'fresh'), async (out: string) => { writeFileSync(join(out, 'a'), 'a'); });
  assert.ok(existsSync(join(dir, 'fresh', 'a')));
});

test('scripts/build.mjs with a dependency missing fails and keeps dist/', { timeout: 120_000 }, t => {
  const dir = scratch(t);
  for (const name of ['package.json', 'tsconfig.json', 'scripts', 'src', 'commands', 'agents', 'pi-prompts']) {
    if (existsSync(join(root, name))) cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  // node_modules without the relay driver, as on the day a dependency was missing.
  mkdirSync(join(dir, 'node_modules'));
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry !== '@wezzard') symlinkSync(join(root, 'node_modules', entry), join(dir, 'node_modules', entry));
  }
  seed(dir);
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, stdio: 'pipe', env: childEnvironment() }));
  assert.equal(readFileSync(join(dir, 'dist', 'server.mjs'), 'utf8'), 'the committed build');
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.dist')), [], 'no partial build is left');
});
