/**
 * A hostile shell reaches nothing real (DC-61 to DC-64). The shell
 * selects an instance (VM_ENVIRONMENT_FILE), points MACHCTL and TART at
 * recording scripts that also lead PATH, and names the installed origin
 * (MCP_RELAY_URL, MACHINE_SERVICE_URL = localhost:6240). The "real instance" is
 * a recording listener; the test passes only if neither the listener nor a
 * recording script ever hears from the tests or the relay they start.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { relayManagerFromProcess } from '../src/manager.js';
import { childEnvironment } from './isolation.js';
import { testPython } from '../scripts/isolation.mjs';

const run = promisify(execFile);
const server = resolve('dist/server.mjs');

async function hostile(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-hostile-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heard = join(root, 'heard.log');
  // The real instance: anything that reaches it is recorded.
  const listener = createServer((req, res) => { void writeFile(heard, `http ${req.method} ${req.url}\n`, { flag: 'a' }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { listener.closeAllConnections(); listener.close(() => done()); }));
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  // The real tools: a run of either is recorded.
  const bin = join(root, 'bin'); await mkdir(bin);
  for (const name of ['machctl', 'tart']) { await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${heard}'\necho '[]'\n`); await chmod(join(bin, name), 0o755); }
  const repository = join(root, 'images-repo'); await mkdir(join(repository, 'images'), { recursive: true });
  const profile = join(root, 'environment.json');
  await writeFile(profile, JSON.stringify({ schemaVersion: 2, id: 'hostile', vmServiceUrl: origin, imageRepository: repository, tartHome: join(root, 'tart'), serviceStateDir: join(root, 'service'),
    imageStateDir: join(root, 'image-state'), relayStateDir: join(root, 'relay-state'), machctlPath: join(bin, 'machctl'), tartPath: join(bin, 'tart') }));
  const shell: Record<string, string> = {
    VM_ENVIRONMENT_FILE: profile, MACHCTL: join(bin, 'machctl'), TART: join(bin, 'tart'), TART_HOME: join(root, 'tart'),
    MCP_RELAY_URL: 'http://localhost:6240', MACHINE_SERVICE_URL: 'http://localhost:6240', HOME: root,
  };
  const heardNothing = async () => assert.equal(await readFile(heard, 'utf8').catch(() => ''), '', 'the real instance or a real tool was reached');
  return { root, bin, origin, profile, shell, heardNothing };
}

test('the test runner starts the tests from an empty allowlist: a hostile shell reaches no test', { timeout: 120_000 }, async t => {
  const h = await hostile(t);
  const probe = join(h.root, 'probe.test.mjs'), seen = join(h.root, 'seen.json');
  await writeFile(probe, `import { spawnSync } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import test from 'node:test';
test('probe', () => { writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env, machctl: spawnSync('machctl', ['list']).error?.code ?? 'ran', tart: spawnSync('tart', ['list']).error?.code ?? 'ran' })); });\n`);
  const shell = { ...h.shell, PATH: `${h.bin}:${childEnvironment().PATH}`, MCP_RELAY_TEST_EXAMPLE: 'kept' };
  await run(process.execPath, [resolve('scripts/test.mjs'), probe], { env: shell });
  const { env, machctl, tart } = JSON.parse(await readFile(seen, 'utf8'));
  for (const name of ['VM_ENVIRONMENT_FILE', 'MACHCTL', 'TART', 'TART_HOME', 'MCP_RELAY_URL', 'MACHINE_SERVICE_URL']) assert.equal(env[name], undefined, name);
  assert.notEqual(env.HOME, h.root);
  assert.ok(!env.PATH.split(':').includes(h.bin), 'the shell PATH does not reach a test');
  assert.equal(env.MCP_RELAY_ISOLATED, '1');
  assert.equal(env.MCP_RELAY_TEST_EXAMPLE, 'kept', 'a test input crosses by its prefix');
  assert.deepEqual([machctl, tart], ['ENOENT', 'ENOENT'], 'no machctl or tart is found by name');
  await h.heardNothing();
});

test('a server a test starts gets only what the test names, whatever the runner holds', { timeout: 60_000 }, async t => {
  const h = await hostile(t);
  // Even with the hostile values on the runner itself, the child sees none of them.
  const saved = Object.assign({}, process.env);
  t.after(() => { for (const key of Object.keys(h.shell)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, h.shell);
  const project = join(h.root, 'project'); await mkdir(project);
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: childEnvironment({ HOME: join(h.root, 'home'), MCP_RELAY_PROJECT: project, MCP_RELAY_STATE_DIR: join(h.root, 'state'), MCP_RELAY_URL: 'http://127.0.0.1:9' }) });
  const client = new Client({ name: 'isolation-guard', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  const search: any = await client.callTool({ name: 'relay_search', arguments: { name: 'Firefox' } });
  assert.equal(search.isError, true); assert.match(search.content[0].text, /127\.0\.0\.1:9|request failed/);
  const status: any = await client.callTool({ name: 'relay_status', arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.service, 'http://127.0.0.1:9'); assert.equal(payload.environment, undefined);
  await h.heardNothing();
});

test('a server the tests start is refused the installed instance and has no default', { timeout: 60_000 }, async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{}, /a test gets no default/],
    [{ MACHINE_SERVICE_URL: 'http://localhost:6240' }, /a test gets no default/],
    [{ MCP_RELAY_URL: 'http://localhost:6240' }, /installed machine-service's origin/],
    [{ MCP_RELAY_URL: 'http://127.0.0.1:6240/' }, /installed machine-service's origin/],
    [{ MCP_RELAY_URL: 'http://[::1]:6240' }, /installed machine-service's origin/],
  ];
  for (const [variables, refusal] of cases) {
    await assert.rejects(run(process.execPath, [server], { env: childEnvironment(variables), timeout: 20_000 }), (error: any) => {
      assert.equal(error.code, 1, JSON.stringify(variables)); assert.match(error.stderr, refusal, JSON.stringify(variables)); return true;
    });
  }
});

test('in a test process the production factory supplies no default and refuses the installed instance', async t => {
  const h = await hostile(t);
  const settings = { sessionId: 'guard', project: h.root };
  assert.throws(() => relayManagerFromProcess(settings, { MCP_RELAY_ISOLATED: '1', HOME: h.root }), /a test gets no default/);
  assert.throws(() => relayManagerFromProcess(settings, { MCP_RELAY_ISOLATED: '1', HOME: h.root, MCP_RELAY_URL: 'http://localhost:6240' }), /installed machine-service/);
  // The test runner itself carries the flag (scripts/test.mjs).
  assert.equal(process.env.MCP_RELAY_ISOLATED, '1');
  await h.heardNothing();
});

test('no test copies the runner environment into a child or finds a tool on the shell PATH', async () => {
  const files = [...(await readdir('tests')).filter(name => name.endsWith('.ts')).map(name => join('tests', name)), ...(await readdir('tests/e2e')).map(name => join('tests/e2e', name))];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /\.\.\.\s*process\.env\b/, `${file} spreads process.env`);
    assert.doesNotMatch(text, /\$\{process\.env\.PATH\}|PATH:\s*process\.env\.PATH/, `${file} gives a child the shell PATH`);
    assert.doesNotMatch(text, /process\.env\.MACHCTL\b/, `${file} finds machctl in the shell's environment`);
  }
  assert.equal((spawnSync('machctl', ['--version'], { env: childEnvironment() }).error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
});

test('CI builds machctl from the pinned machine-service commit and installs nothing over the runner (DC-65)', async () => {
  const ci = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(await readFile('.github/machine-service.commit', 'utf8'), /^[0-9a-f]{40}\n$/);
  assert.match(ci, /ref: \$\{\{ steps\.machine-service\.outputs\.commit \}\}/);
  assert.match(ci, /< \.github\/machine-service\.commit/);
  assert.doesNotMatch(ci, /npm install (-g|--global)\b/);
  assert.doesNotMatch(ci, /^\s+MACHCTL:/m, 'machctl reaches the tests only as MCP_RELAY_TEST_MACHCTL');
});

test('in a test process durable-machine discovery runs only through an injected seam (DC-67)', { timeout: 60_000 }, async t => {
  const h = await hostile(t);
  // The LAN: a Consul agent that records any question, as the hostile listener does.
  const saved = { mode: process.env.MACHINE_SERVICE_DISCOVERY, consul: process.env.CONSUL_HTTP_ADDR };
  t.after(() => { for (const [name, value] of [['MACHINE_SERVICE_DISCOVERY', saved.mode], ['CONSUL_HTTP_ADDR', saved.consul]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.CONSUL_HTTP_ADDR = h.origin;
  const env = { MCP_RELAY_ISOLATED: '1', HOME: join(h.root, 'home'), MCP_RELAY_URL: 'http://127.0.0.1:9', MCP_RELAY_STATE_DIR: join(h.root, 'state') };
  for (const mode of ['bonjour', 'consul']) {
    process.env.MACHINE_SERVICE_DISCOVERY = mode;
    const manager = relayManagerFromProcess({ sessionId: `discovery-${mode}`, project: h.root }, env);
    t.after(() => manager.cleanup('discovery guard'));
    await assert.rejects(manager.durableOwner('Build-Mac-1'), new RegExp(`MCP_RELAY_ISOLATED=1: .*injected.*real ${mode} discovery`), mode);
    await assert.rejects(manager.acquire({ machine: 'Build-Mac-1', task: 'discovery-guard', extractions: [], ttlHours: 0.5 } as any), /MCP_RELAY_ISOLATED=1: .*injected/, mode);
  }
  await h.heardNothing();
  // A seam still works: the injected answer is the only one asked.
  const asked: string[] = [];
  const { findDurableOwner } = await import('../src/discovery.js');
  const local = { baseUrl: 'http://127.0.0.1:9', health: async () => ({}), list: async () => ({ machines: {} }) } as any;
  await assert.rejects(findDurableOwner('Build-Mac-1', { local, mode: 'consul', secondLookMs: 0, fetchJson: async url => { asked.push(url); return []; } }), /No machine-service instance lists/);
  await assert.rejects(findDurableOwner('Build-Mac-1', { local, mode: 'bonjour', secondLookMs: 0, browse: async () => { asked.push('browse'); return []; } }), /No machine-service instance lists/);
  assert.deepEqual(asked, [`${h.origin}/v1/health/service/machine-service`, 'browse', 'browse']);
});

test('the runner resolves the tests\' python3 once, to an absolute file, and records it (DC-69)', { timeout: 120_000 }, async t => {
  const h = await hostile(t);
  // A python3 reached through a link on the caller's PATH, and one named.
  const real = join(h.root, 'python-real'); await mkdir(real);
  await writeFile(join(real, 'python3'), '#!/bin/sh\nexit 0\n'); await chmod(join(real, 'python3'), 0o755);
  const linked = join(h.root, 'python-linked'); await mkdir(linked);
  await symlink(join(real, 'python3'), join(linked, 'python3'));
  await writeFile(join(h.root, 'not-executable'), '');
  assert.equal(testPython({ PATH: `relative:${linked}:/usr/bin` }), join(real, 'python3'), 'the first absolute PATH entry, resolved');
  assert.equal(testPython({ PATH: '/usr/bin', MCP_RELAY_TEST_PYTHON: join(linked, 'python3') }), join(real, 'python3'), 'the named one, resolved');
  assert.equal(testPython({ PATH: '', CI: 'true', MCP_RELAY_TEST_PYTHON: join(real, 'python3') }), join(real, 'python3'));
  assert.throws(() => testPython({ PATH: linked, MCP_RELAY_TEST_PYTHON: 'python3' }), /must be an absolute path/);
  assert.throws(() => testPython({ PATH: linked, MCP_RELAY_TEST_PYTHON: join(h.root, 'not-executable') }), /not an executable file/);
  assert.throws(() => testPython({ PATH: linked, CI: 'true' }), /CI must name the tests' python3/);
  assert.throws(() => testPython({ PATH: join(h.root, 'nothing') }), /no python3 on PATH/);
  // The runner: the probe sees the resolved path, and the python3 on its PATH is that file.
  const probe = join(h.root, 'python.test.mjs'), seen = join(h.root, 'python.json');
  await writeFile(probe, `import { readlinkSync } from 'node:fs'; import { join } from 'node:path'; import { writeFileSync } from 'node:fs'; import test from 'node:test';
test('probe', () => { writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ named: process.env.MCP_RELAY_TEST_PYTHON, link: readlinkSync(join(process.env.MCP_RELAY_TEST_TOOLS, 'python3')) })); });\n`);
  await run(process.execPath, [resolve('scripts/test.mjs'), probe], { env: { ...h.shell, PATH: `${linked}:${childEnvironment().PATH}` } });
  assert.deepEqual(JSON.parse(await readFile(seen, 'utf8')), { named: join(real, 'python3'), link: join(real, 'python3') });
  await assert.rejects(run(process.execPath, [resolve('scripts/test.mjs'), probe], { env: { ...h.shell, PATH: `${linked}:${childEnvironment().PATH}`, CI: 'true' } }), (error: any) => {
    assert.equal(error.code, 2); assert.match(error.stderr, /CI must name the tests' python3 with MCP_RELAY_TEST_PYTHON/); return true;
  });
  await h.heardNothing();
});

test('CI and the release name the tests\' python3 and install nothing over the runner (DC-68, DC-69)', async () => {
  for (const workflow of ['ci.yml', 'release.yml']) {
    const text = await readFile(join('.github/workflows', workflow), 'utf8');
    assert.doesNotMatch(text, /npm install (-g|--global)\b/, workflow);
    assert.match(text, /npm install --prefix "\$RUNNER_TEMP\/npm" npm@latest/, workflow);
    assert.match(text, /^\s+MCP_RELAY_TEST_PYTHON: \/\S+$/m, `${workflow} names an absolute python3`);
    assert.match(text, /^\s+MCP_RELAY_TEST_MACHCTL: /m, workflow);
    assert.doesNotMatch(text, /^\s+MACHCTL:/m, `${workflow}: machctl reaches the tests only as MCP_RELAY_TEST_MACHCTL`);
    assert.match(text, /ref: \$\{\{ steps\.machine-service\.outputs\.commit \}\}/, workflow);
  }
});
