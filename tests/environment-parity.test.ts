import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, delimiter } from 'node:path';
import { command } from '../src/util.js';
import { environmentVariables, loadEnvironment } from '../src/environment.js';

// machine-service's CLI is `machctl`, which replaced `vmctl` (machine-service
// DC-35). Resolve it: an explicit `MACHCTL` override, then `PATH`, then the
// sibling checkout's release build. A missing binary skips with a reason
// instead of passing silently.
function resolveMachctl(): string | undefined {
  const explicit = process.env.MACHCTL;
  if (explicit && existsSync(explicit)) return explicit;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = directory ? join(directory, 'machctl') : '';
    if (candidate && existsSync(candidate)) return candidate;
  }
  const sibling = resolve('../machine-service/rust/target/release/machctl');
  return existsSync(sibling) ? sibling : undefined;
}
const resolvedMachctl = resolveMachctl();
const machctl = resolvedMachctl ?? 'machctl';
const imageBootstrap = resolve('../pilot-images/host/environment.py');
const missing = [
  resolvedMachctl ? undefined : 'machctl (set MACHCTL, add it to PATH, or build machine-service/rust)',
  existsSync(imageBootstrap) ? undefined : `pilot-images checkout at ${imageBootstrap}`,
]
  .filter((value): value is string => value !== undefined)
  .join('; ');

test('TypeScript, the machine-service CLI, and image bootstrap agree on canonical selected environments', { skip: missing ? `missing ${missing}` : false }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-environment-parity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'image-repo-界-😀'); await mkdir(join(repo, 'images'), { recursive: true });
  const tart = join(root, 'fake-tart'); await writeFile(tart, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const path = join(root, 'environment.json');
  const profile = { schemaVersion: 2, id: 'cross-runtime', vmServiceUrl: 'http://127.0.0.1:6249', imageRepository: repo,
    tartHome: join(root, 'tart'), serviceStateDir: join(root, 'service'), imageStateDir: join(root, 'image-state'), relayStateDir: join(root, 'relay'), machctlPath: machctl, tartPath: tart };
  const env = { ...process.env, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'xdg'), VM_ENVIRONMENT_FILE: path, VM_ENVIRONMENT_FINGERPRINT: undefined,
    TART_HOME: '/wrong', PILOT_REPO: '/wrong', MACHINE_SERVICE_STATE: '/wrong', MCP_RELAY_URL: 'http://127.0.0.1:1', PYTHONDONTWRITEBYTECODE: '1' };
  const positive = [profile, { ...profile, vmServiceUrl: 'http://localhost:00080/' }, { ...profile, vmServiceUrl: 'http://[::1]:6249/' }];
  for (const value of positive) {
    await writeFile(path, JSON.stringify(value));
    const selected = loadEnvironment(path, env);
    const output = await command([machctl, 'environment', '--json'], { env, maxBytes: 1024 * 1024 });
    assert.equal(output.code, 0, output.stderr);
    const bundle = JSON.parse(output.stdout);
    assert.deepEqual(bundle.profile, selected.profile);
    assert.deepEqual(bundle.identity, selected.identity);
    assert.deepEqual(bundle.environment, environmentVariables(selected));
    const image = await command(['python3', '-c', `import importlib.util,json,sys; from pathlib import Path; s=importlib.util.spec_from_file_location('bootstrap',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.resolve(repository=Path(sys.argv[2]))))`, imageBootstrap, repo], { env, maxBytes: 1024 * 1024 });
    assert.equal(image.code, 0, image.stderr);
    assert.deepEqual(JSON.parse(image.stdout), bundle.environment);
  }
  await writeFile(path, JSON.stringify(profile).replace('"schemaVersion":2', '"schemaVersion":2.0'));
  assert.equal(loadEnvironment(path, env).profile.schemaVersion, 2);
  assert.equal((await command([machctl, '--environment', relative(process.cwd(), path), 'environment', '--json'], { env })).code, 0);
  const alias = join(root, 'alias'); await symlink(join(root, 'absent'), alias);
  const invalid = [
    JSON.stringify({ ...profile, extra: 1 }), JSON.stringify({ ...profile, tartHome: 'relative' }),
    JSON.stringify({ ...profile, tartHome: join(alias, 'store') }),
    JSON.stringify({ ...profile, tartHome: join(root, 'home/.local/state/machine-service') }),
    JSON.stringify({ ...profile, serviceStateDir: profile.tartHome }),
    JSON.stringify({ ...profile, tartHome: join(root, 'invalid\nstore') }),
    JSON.stringify({ ...profile, tartHome: join(root, 'invalid\ud800store') }),
    JSON.stringify({ ...profile, vmServiceUrl: 'http://localhost:000080' }),
    JSON.stringify(profile).replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    // AC-45: a profile from before the rename is refused by every reader (machine-service DC-42).
    JSON.stringify({ ...profile, schemaVersion: 1 }),
    JSON.stringify(Object.fromEntries(Object.entries(profile).map(([key, value]) => [key === 'machctlPath' ? 'vmctlPath' : key, value]))),
    '\ufeff' + JSON.stringify(profile),
  ];
  for (const raw of invalid) {
    await writeFile(path, raw);
    assert.throws(() => loadEnvironment(path, env));
    const result = await command([machctl, 'environment', '--json'], { env });
    assert.notEqual(result.code, 0, 'machctl accepted rejected profile: ' + raw);
  }
  assert.equal((await readdir(root)).some(n => ['tart', 'service', 'image-state', 'relay', 'home', 'xdg'].includes(n)), false, 'profile resolution must not create runtime roots');
  assert.equal(await readFile(tart, 'utf8'), '#!/bin/sh\nexit 97\n');
});
