import { build } from 'esbuild';
import { readFile, writeFile, chmod, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { COMMAND_DIRS, hostCommandFiles } from './host-commands.mjs';
import { createHash } from 'node:crypto';
import { replaceOnSuccess } from './replace-on-success.mjs';
// The host command files are generated whole: clear their directories so a
// renamed or removed command leaves nothing stale behind.
for (const dir of Object.values(COMMAND_DIRS)) await rm(dir, { recursive: true, force: true });
for (const [path, content] of Object.entries(hostCommandFiles())) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true, define: { __MCP_RELAY_VERSION__: JSON.stringify(pkg.version) } };
// Bundled CommonJS dependencies need a real require; esbuild's ESM output gets one from this banner.
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
// Build into a new folder and replace dist/ only when every step succeeded, so
// a failed build (a missing dependency, say) never leaves dist/ empty or half
// written.
await replaceOnSuccess('dist', async out => {
  const receiver = await build({ ...common, entryPoints: ['src/guest/receiver.ts'], outfile: `${out}/receiver.mjs`, banner: { js: banner } });
  const server = await build({ ...common, entryPoints: ['src/server.ts'], outfile: `${out}/server.mjs`, banner: { js: `#!/usr/bin/env node\n${banner}` } });
  const doctor = await build({ ...common, entryPoints: ['src/doctor.ts'], outfile: `${out}/doctor.mjs`, banner: { js: `#!/usr/bin/env node\n${banner}` } });
  // Programs that read relay packages derive their review data with the relay's own rules.
  const reviewData = await build({ ...common, entryPoints: ['src/review-data.ts'], outfile: `${out}/review-data.mjs`, banner: { js: banner } });
  {
    const types = await mkdtemp(join(tmpdir(), 'mcp-relay-types-'));
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--ignoreConfig', 'src/review-data.ts', '--declaration', '--emitDeclarationOnly', '--outDir', types,
      '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node']);
    // The declarations are self-contained: the types live in src/review-data.ts.
    await writeFile(`${out}/review-data.d.ts`, await readFile(join(types, 'review-data.d.ts')));
    await rm(types, { recursive: true, force: true });
  }
  await chmod(`${out}/server.mjs`, 0o755); await chmod(`${out}/doctor.mjs`, 0o755);
  // Compiled relay-driver code is shipped, not fetched by users or copied into VM
  // images. Keep exact build provenance; release publication remains explicit.
  const packages = [];
  for (const name of ['core', 'host-sdk', 'remote-runtime']) {
    const manifest = JSON.parse(await readFile(`node_modules/@wezzard/relay-driver-${name}/package.json`, 'utf8'));
    packages.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? 'UNSPECIFIED', source: 'https://github.com/WeZZard/relay-driver' });
  }
  const sources = {};
  for (const path of [...new Set([receiver, server, doctor, reviewData].flatMap(r => Object.keys(r.metafile.inputs)))].sort()) {
    const key = path.includes('relay-driver/') ? `relay-driver/${path.split('relay-driver/').at(-1)}` : path;
    sources[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  await writeFile(`${out}/build-info.json`, JSON.stringify({ formatVersion: 1, packages, sources }, null, 2) + '\n');
  await writeFile(`${out}/NOTICE.txt`, 'This distribution includes compiled @wezzard/relay-driver-core, @wezzard/relay-driver-host-sdk and @wezzard/relay-driver-remote-runtime code (https://github.com/WeZZard/relay-driver), the Model Context Protocol TypeScript SDK, Ajv with ajv-formats, and the ws WebSocket library (MIT). See build-info.json for source hashes and versions. The relay implementation was inherited from pi-vm-relay (https://github.com/WeZZard/pi-vm-relay) at commit 8990123, synchronized with its implementation through commit 0d69fc7 before that project\'s retirement, and has been maintained here as mcp-relay\'s own implementation from then on.\n');
  const integrity = {};
  for (const name of ['server.mjs', 'receiver.mjs', 'doctor.mjs', 'review-data.mjs']) integrity[name] = createHash('sha256').update(await readFile(`${out}/${name}`)).digest('hex');
  await writeFile(`${out}/integrity.json`, JSON.stringify(integrity, null, 2) + '\n');
});
