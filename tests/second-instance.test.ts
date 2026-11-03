/**
 * The selected-image lifecycle drives only a second instance that
 * machine-service's launcher started, never the installed one (DC-6x-ISO2-1).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { confirmMark, flagValue, MANIFEST, ownRegistry, readSecondInstance, secondInstance } from '../scripts/second-instance.js';
import { childEnvironment } from './isolation.js';

const run = promisify(execFile);

async function scratch(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-second-instance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), instance = join(root, 'instance'), store = join(root, 'store');
  await Promise.all([mkdir(join(home, '.tart'), { recursive: true }), mkdir(instance), mkdir(store)]);
  const manifest = { id: 'a1b2c3', root: instance, created_root: true, port: 16240, session_port: 16241, bind: '127.0.0.1', tart_home: store };
  return { root, home, instance, store, manifest };
}

test('a launcher manifest on resources of its own is the instance a live tool reaches', async t => {
  const s = await scratch(t);
  assert.deepEqual(secondInstance(s.manifest, s.instance, s.home), { id: 'a1b2c3', root: s.instance, origin: 'http://127.0.0.1:16240', port: 16240, tartHome: s.store });
  assert.equal(secondInstance({ ...s.manifest, bind: '::1' }, s.instance, s.home).origin, 'http://[::1]:16240');
  await writeFile(join(s.instance, MANIFEST), JSON.stringify(s.manifest));
  assert.equal((await readSecondInstance(s.instance, s.home)).id, 'a1b2c3');
});

test('the installed instance, the default Tart store and anything unmarked are refused', async t => {
  const s = await scratch(t);
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ port: 6240 }, /port 6240 is the installed instance's/],
    [{ session_port: 6241 }, /port 6241 is the installed instance's/],
    [{ tart_home: join(s.home, '.tart') }, /default one \(~\/\.tart\)/],
    [{ tart_home: join(s.home, '.tart', 'vms') }, /default one/],
    [{ tart_home: s.home }, /default one/],
    [{ bind: '0.0.0.0' }, /on loopback/],
    [{ bind: '192.0.2.10' }, /on loopback/],
    [{ id: 'Not-An-Id' }, /names no second-instance id/],
    [{ id: undefined }, /names no second-instance id/],
    [{ root: join(s.root, 'other') }, /manifest of another root/],
    [{ tart_home: 'store' }, /names no Tart store/],
  ];
  for (const [patch, refusal] of refused) assert.throws(() => secondInstance({ ...s.manifest, ...patch }, s.instance, s.home), refusal, JSON.stringify(patch));
  await assert.rejects(readSecondInstance(s.instance, s.home), /no second-instance\.json; start one with machine-service's second-instance launcher/);
  await assert.rejects(readSecondInstance('instance', s.home), /must be an absolute path/);
  const instance = secondInstance(s.manifest, s.instance, s.home);
  confirmMark(instance, { service: 'machine-service', second_instance: { id: 'a1b2c3' } });
  assert.throws(() => confirmMark(instance, { service: 'machine-service' }), /carries no second-instance mark/);
  assert.throws(() => confirmMark(instance, { second_instance: { id: 'ffff' } }), /marks instance ffff, not a1b2c3/);
  assert.equal(ownRegistry(join(s.root, 'evidence/relay'), s.home), join(s.root, 'evidence/relay'));
  assert.throws(() => ownRegistry(join(s.home, 'AGENTS.md'), s.home), /operator's/);
  assert.throws(() => ownRegistry(join(s.home, '.local/state/mcp-relay'), s.home), /operator's/);
  assert.equal(flagValue(['--run', '--instance', '/x'], '--instance'), '/x');
  assert.equal(flagValue(['--run'], '--instance'), undefined);
  assert.throws(() => flagValue(['--instance', '--tart', '/t'], '--instance'), /needs a value/);
  assert.throws(() => flagValue(['--instance', '/a', '--instance', '/b'], '--instance'), /given twice/);
});

test('the lifecycle script refuses, before any evidence or lease, an instance that is not a marked second instance', { timeout: 120_000 }, async t => {
  const s = await scratch(t);
  // An unmarked instance: the installed one would answer like this.
  const heard: string[] = [];
  const server = createServer((req, res) => { heard.push(`${req.method} ${req.url}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ service: 'machine-service' })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const port = (server.address() as { port: number }).port;
  await writeFile(join(s.instance, MANIFEST), JSON.stringify({ ...s.manifest, port }));
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const script = resolve('scripts/selected-image-lifecycle.ts');
  const evidence = async () => (await readdir(resolve('test-evidence')).catch(() => [] as string[])).filter(name => name.startsWith('selected-image-lifecycle-'));
  const before = await evidence();
  const lifecycle = (...args: string[]) => run(process.execPath, [tsx, script, '--run', ...args], { env: childEnvironment({ HOME: s.home }), timeout: 60_000 });
  const refusals: Array<[string[], RegExp]> = [
    [[], /--instance <root> is required/],
    [['--instance', s.instance], /--tart <absolute path> is required/],
    [['--instance', s.instance, '--tart', 'tart'], /--tart <absolute path> is required/],
    [['--instance', s.instance, '--tart', '/bin/sh'], /carries no second-instance mark/],
  ];
  for (const [args, refusal] of refusals) {
    await assert.rejects(lifecycle(...args), (error: any) => { assert.match(error.stderr, refusal, args.join(' ')); return true; });
  }
  await writeFile(join(s.instance, MANIFEST), JSON.stringify({ ...s.manifest, port, tart_home: join(s.home, '.tart') }));
  await assert.rejects(lifecycle('--instance', s.instance, '--tart', '/bin/sh'), (error: any) => { assert.match(error.stderr, /default one \(~\/\.tart\)/); return true; });
  // Only the one /health read of the mark; no lease, no evidence.
  assert.deepEqual(heard, ['GET /health']);
  assert.deepEqual(await evidence(), before);
  assert.match(await readFile(script, 'utf8'), /confirmMark\(instance,health\);[\s\S]*await mkdir\(join\(root,'audit'\)/, 'the mark is confirmed before any evidence is made');
});
