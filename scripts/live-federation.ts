// Live regression of machine-service FD-7 (DC-7x-FED-6): relay_search and
// relay_acquisition_capabilities from a Mac whose own instance offers
// nothing. It is read-only; run it deliberately, on a Mac on the lab's
// network:
//
//   npm run build
//   npx tsx scripts/live-federation.ts --name Xcode [--os macos] [--server <server.mjs>] <outDir>
//
// It names no instance. It browses `_machine-service._tcp` at run time, asks
// each instance found for its `/health` and `/applications`, and keeps those
// whose own catalog matches the query. It then starts the built server with
// its loopback instance pointed at an instance of its own that answers an
// empty catalog, as an instance configured to offer nothing does (DC-93), and
// checks that relay_search names every one of those instances and that
// relay_acquisition_capabilities answers for each. It sends only `GET`
// requests and read-only tool calls: it never acquires, reloads or releases,
// and its own instance refuses any other method and fails the run if asked.
//
// Before FD-7 the relay asked only its loopback instance, so relay_search
// answered `{"applications":[],"truncated":false}` here and the run failed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browseService } from '../src/mdns.js';
import { SERVICE_TYPE } from '../src/discovery.js';
import { searchCatalog } from '../src/search.js';

const usage = 'usage: npx tsx scripts/live-federation.ts --name <application> [--os macos|linux] [--server <server.mjs>] <outDir>';
const argv = process.argv.slice(2);
const flag = (name: string) => { const at = argv.indexOf(name); if (at < 0) return undefined; const value = argv[at + 1]; argv.splice(at, 2); if (!value) throw new Error(`${name} needs a value`); return value; };
let name: string | undefined, os: string | undefined, server: string;
try { name = flag('--name'); os = flag('--os'); server = resolve(flag('--server') ?? fileURLToPath(new URL('../dist/server.mjs', import.meta.url))); }
catch (error) { console.error(`live-federation: ${(error as Error).message}\n${usage}`); process.exit(2); }
const [outArg, ...extra] = argv;
if (!name || !outArg || extra.length || (os !== undefined && os !== 'macos' && os !== 'linux')) { console.error(usage); process.exit(2); }
if (process.env.MCP_RELAY_ISOLATED === '1') { console.error('live-federation: a live check reads the real network; it does not run under the test harness (DC-61)'); process.exit(2); }
await mkdir(resolve(outArg), { recursive: true, mode: 0o700 });
// The relay refuses a state folder behind a symbolic link or open to others, so the run's folders are resolved and private.
const outDir = await realpath(resolve(outArg));
const query = { name, ...(os ? { os: os as 'macos' | 'linux' } : {}) };
const fail = (message: string): never => { console.error(`live-federation: FAIL: ${message}`); process.exit(1); };

async function getJson(origin: string, path: string): Promise<any> {
  const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(40000) });
  if (!response.ok) throw new Error(`${origin}${path}: HTTP ${response.status}`);
  return response.json();
}

// 1. What the network holds, read directly.
const advertised = await browseService(SERVICE_TYPE);
const holders: Array<{ instance: string; machine_id: string; origin: string; images: string[] }> = [];
for (const found of advertised) {
  const origin = new URL(`http://${found.address ?? found.host}:${found.port}`).origin;
  try {
    const health = await getJson(origin, '/health');
    if (health.service !== 'machine-service' || typeof health.machine_id !== 'string') continue;
    const matched = searchCatalog(await getJson(origin, '/applications'), query);
    const images = matched.applications.flatMap(app => app.installations.map(installation => installation.image));
    if (images.length) holders.push({ instance: health.instance, machine_id: health.machine_id, origin, images });
  } catch (error) { console.error(`live-federation: note: ${origin}: ${(error as Error).message}`); }
}
await writeFile(join(outDir, 'holders.json'), JSON.stringify(holders, null, 2));
if (!holders.length) { console.error(`live-federation: no instance found on the network lists ${name}${os ? ` on ${os}` : ''}, so there is nothing to prove`); process.exit(3); }

// 2. A loopback instance of the run's own that offers nothing, and refuses anything but a read.
const refused: string[] = [];
const empty = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'GET') { refused.push(`${req.method} ${req.url}`); res.statusCode = 405; return res.end(JSON.stringify({ error: 'this live check reads only' })); }
  const answers: Record<string, unknown> = {
    '/health': { ok: true, service: 'machine-service', instance: 'live-check-local', machine_id: 'live-check-local', former_names: [], kinds: [] },
    '/applications': { schemaVersion: 1, images: [] },
    '/images': { images: {}, capacity: { macos_running: 0, macos_limit: 0 }, catalog: { status: 'current', generation: 1 } },
    '/machines': { machines: {}, limits: { max_macos_running: 0, grace_hours: 0 }, pilot_repo: '', port: 0 },
    '/acquisition-capabilities': { schemaVersion: 1, options: { vnc: { default: false, backends: { linux: { available: false }, macos: { available: false } } } } },
  };
  const answer = answers[req.url ?? ''];
  if (answer === undefined) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
  res.end(JSON.stringify(answer));
});
await new Promise<void>(done => empty.listen(0, '127.0.0.1', done));
const address = empty.address();
if (!address || typeof address === 'string') fail('the loopback instance did not listen');
const local = `http://127.0.0.1:${(address as { port: number }).port}`;

// 3. The built server, with nothing of the operator's: its own HOME, state and project.
for (const folder of ['home', 'state', 'project']) await mkdir(join(outDir, folder), { recursive: true, mode: 0o700 });
if (!isAbsolute(server)) fail(`${server} is not an absolute path`);
const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'inherit', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(outDir, 'home'), MCP_RELAY_URL: local, MCP_RELAY_STATE_DIR: join(outDir, 'state'), MCP_RELAY_PROJECT: join(outDir, 'project') } });
const client = new Client({ name: 'live-federation', version: '0' });
await client.connect(transport);
const call = async (tool: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: tool, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  await writeFile(join(outDir, `${tool}.json`), text);
  if (result.isError) fail(`${tool} answered an error: ${text}`);
  return JSON.parse(text);
};
try {
  const search = await call('relay_search', query);
  for (const holder of holders) {
    const offers = (search.applications ?? []).flatMap((app: any) => app.installations ?? []).filter((installation: any) => (installation.instances ?? []).some((offer: any) => offer.machine_id === holder.machine_id));
    if (!offers.length) fail(`relay_search for ${name} names no installation on ${holder.instance} (${holder.machine_id}), whose own catalog lists it in ${holder.images.join(', ')}; it answered ${JSON.stringify(search).slice(0, 400)}`);
    for (const image of holder.images) if (!offers.some((installation: any) => installation.image === image)) fail(`relay_search names ${holder.instance} for ${name} but not in ${image}`);
  }
  const capabilities = await call('relay_acquisition_capabilities', {});
  for (const holder of holders) if (!(capabilities.instances ?? []).some((entry: any) => entry.machine_id === holder.machine_id && entry.capabilities)) fail(`relay_acquisition_capabilities has no answer from ${holder.instance} (${holder.machine_id})`);
  if (refused.length) fail(`the relay sent ${refused.join(', ')} to its loopback instance`);
  console.log(`live-federation: PASS: relay_search for ${name}${os ? ` on ${os}` : ''} names ${holders.map(holder => `${holder.instance} (${holder.images.join(', ')})`).join('; ')}`);
} finally {
  await client.close(); empty.close();
}
