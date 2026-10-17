// Live check: starts this checkout's built MCP server over stdio and runs one
// scripted sequence of relay tool calls against a real VM through the local
// vm-service. It acquires, runs and finishes a real VM; run it deliberately.
//
//   npm run build
//   node scripts/live-check.mjs scripts/live-checks/ubuntu.json <outDir>
//
// A step is {tool, args, label?, expectError?, stopOnError?, capture?, show?}.
// `capture` maps a name to a regular expression whose first group is taken
// from the step's text; later steps use it as "${name}" inside a string, or as
// the whole string "${name:int}" to pass a number. Every result is saved in
// <outDir> (one JSON file per step, images as files, log.txt). The exit code
// is 1 when a step's error state differs from `expectError`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [stepsFile, outArg] = process.argv.slice(2);
if (!stepsFile || !outArg) { console.error('usage: node scripts/live-check.mjs <steps.json> <outDir>'); process.exit(2); }
const outDir = resolve(outArg);
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.mjs');
await mkdir(join(outDir, 'project'), { recursive: true });
const log = line => appendFile(join(outDir, 'log.txt'), line + '\n').then(() => console.log(line));
const steps = JSON.parse(await readFile(stepsFile, 'utf8'));
// A fixed session id lets separate runs resume the same owned lease.
const session = process.env.LIVE_CHECK_SESSION ?? `live-check-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath, args: [server],
  env: { ...process.env, MCP_RELAY_PROJECT: join(outDir, 'project'), MCP_RELAY_SESSION: session },
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
await log(failed ? `${failed} unexpected result(s)` : 'all steps as expected');
process.exitCode = failed ? 1 : 0;
