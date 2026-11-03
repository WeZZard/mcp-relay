// Live check: starts this checkout's built MCP server over stdio and runs one
// scripted sequence of relay tool calls against a real VM. It acquires, runs
// and finishes a real VM; run it deliberately.
//
//   npm run build
//   node scripts/live-check.mjs --instance <root> --tart <path> <steps.json> <outDir>
//
// The instance is named, never defaulted (DC-64), and is a second instance
// machine-service's launcher started under <root> (DC-7x-LIVE-3): its
// manifest, its daemon's environment and its /health mark are checked by
// scripts/second-instance.mjs, as the lifecycle scripts check them, before
// the server starts, and every machine it lists before and after the run is
// one of its own `si-<id>-` clones. Its Tart store may be the operator's own
// (machine-service DC-246). The server gets only PATH, a HOME of the run's
// own, the instance's origin, its store, the Tart at --tart and a state root
// under <outDir>, where the relay keeps the run's registry, so it reaches
// neither the installed instance nor the operator's ~/AGENTS.md.
//
// A step is {tool, args, label?, expectError?, stopOnError?, capture?, show?}.
// `capture` maps a name to a regular expression whose first group is taken
// from the step's text; later steps use it as "${name}" inside a string, or as
// the whole string "${name:int}" to pass a number. Every result is saved in
// <outDir> (one JSON file per step, images as files, log.txt). The exit code
// is 1 when a step's error state differs from `expectError`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { access, appendFile, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmOwnedMachines, connectSecondInstance, flagValue, instanceTransport, ownRegistry } from './second-instance.mjs';

const usage = 'usage: node scripts/live-check.mjs --instance <root> --tart <path> <steps.json> <outDir>';
const argv = process.argv.slice(2);
const named = new Set(['--instance', '--tart'].flatMap(flag => { const at = argv.indexOf(flag); return at >= 0 ? [at, at + 1] : []; }));
const [stepsFile, outArg, ...extra] = argv.filter((_, index) => !named.has(index));
let instanceRoot, tartPath;
try { instanceRoot = flagValue(argv, '--instance'); tartPath = flagValue(argv, '--tart'); }
catch (error) { console.error(`live-check: ${error.message}\n${usage}`); process.exit(2); }
if (!instanceRoot || !tartPath || !isAbsolute(tartPath) || !stepsFile || !outArg || extra.length) { console.error(usage); process.exit(2); }
const home = process.env.HOME ?? homedir();
let instance;
try {
  await access(tartPath, constants.X_OK);
  ({ instance } = await connectSecondInstance(instanceRoot, home));
} catch (error) { console.error(`live-check: ${error.message}`); process.exit(2); }
const machines = async () => { const response = await instanceTransport(instance)(`${instance.origin}/machines`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }); confirmOwnedMachines(instance, await response.json()); };
try { await machines(); } catch (error) { console.error(`live-check: ${error.message}`); process.exit(2); }
const outDir = resolve(outArg);
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.mjs');
await Promise.all(['project', 'home', 'relay'].map(name => mkdir(join(outDir, name), { recursive: true })));
ownRegistry(join(outDir, 'relay'), home);
const log = line => appendFile(join(outDir, 'log.txt'), line + '\n').then(() => console.log(line));
const steps = JSON.parse(await readFile(stepsFile, 'utf8'));
// A fixed session id lets separate runs resume the same owned lease.
const session = process.env.LIVE_CHECK_SESSION ?? `live-check-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath, args: [server],
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(outDir, 'home'), MCP_RELAY_URL: instance.origin, TART_HOME: instance.tartHome, TART: tartPath, TART_NO_AUTO_PRUNE: '1', MCP_RELAY_STATE_DIR: join(outDir, 'relay'), MCP_RELAY_PROJECT: join(outDir, 'project'), MCP_RELAY_SESSION: session },
  stderr: 'inherit',
});
const client = new Client({ name: 'mcp-relay-live-check', version: '1' });
await client.connect(transport);
const vars = {};
const fill = value => JSON.parse(JSON.stringify(value)
  .replace(/"\$\{(\w+):int\}"/g, (whole, name) => vars[name] ?? whole)
  .replace(/\$\{(\w+)\}/g, (whole, name) => vars[name] ?? whole));
let failed = 0;
try {
  for (const [index, step] of steps.entries()) {
    const n = String(index + 1).padStart(2, '0');
    const args = fill(step.args ?? {});
    const started = Date.now();
    let result;
    // The longest run (3,600,000 ms) plus image delivery and snapshots.
    try { result = await client.callTool({ name: step.tool, arguments: args }, undefined, { timeout: 3_900_000 }); }
    catch (error) { result = { isError: true, content: [{ type: 'text', text: `CLIENT ERROR: ${error.message}` }] }; }
    const ms = Date.now() - started;
    const texts = result.content.filter(c => c.type === 'text').map(c => c.text);
    const images = result.content.filter(c => c.type === 'image');
    for (const [i, image] of images.entries()) await writeFile(join(outDir, `${n}-${step.tool}-${i}.${image.mimeType.split('/')[1]}`), Buffer.from(image.data, 'base64'));
    await writeFile(join(outDir, `${n}-${step.tool}.json`), JSON.stringify({ step, args, isError: result.isError ?? false, ms, texts, images: images.length }, null, 2));
    const unexpected = Boolean(result.isError) !== Boolean(step.expectError);
    if (unexpected) failed++;
    await log(`#${n} ${step.tool} ${step.label ?? ''} -> ${result.isError ? 'error' : 'ok'}${unexpected ? ' (UNEXPECTED)' : ''} (${ms} ms, ${images.length} image(s))\n   ${texts.join('\n').slice(0, step.show ?? 600).replace(/\n/g, '\n   ')}`);
    for (const [name, pattern] of Object.entries(step.capture ?? {})) {
      const match = texts.join('\n').match(new RegExp(pattern));
      if (match) vars[name] = match[1];
      else { failed++; await log(`   capture ${name} found no match for ${pattern}`); }
    }
    if (unexpected && step.stopOnError) { await log(`stopping at #${n}; the VM is kept for repair, finish or release it explicitly`); break; }
  }
} finally {
  await client.close();
}
try { await machines(); } catch (error) { failed++; await log(`after the run: ${error.message}`); }
await log(failed ? `${failed} unexpected result(s)` : 'all steps as expected');
process.exitCode = failed ? 1 : 0;
