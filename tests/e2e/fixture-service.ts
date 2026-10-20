/**
 * A stand-in for machine-service on the loopback, for end-to-end runs of headless
 * Claude Code against the plugin. Leases are records; exec runs the relay's
 * own Node and transfer commands locally under a temporary root; push and
 * pull copy files. The fake CUA driver only writes a constant PNG and refuses
 * input. No VM, real desktop, installed browser or user registry is touched.
 *
 * usage: tsx fixture-service.ts <root> <info-file>
 * Writes {url, port, root, driver} to <info-file> once listening, appends
 * every request to <root>/requests.jsonl, and cleans up on SIGTERM.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, copyFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

const [root, infoFile] = process.argv.slice(2);
if (!root || !infoFile) { process.stderr.write('usage: fixture-service.ts <root> <info-file>\n'); process.exit(2); }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNg+A8AAQIBAEK+vGgAAAAASUVORK5CYII=';
const driver = join(root, 'fake-cua');
await writeFile(driver, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]!=='call'||process.argv[3]!=='get_desktop_state'||process.argv[4]!=='--json')process.exit(99);const a=JSON.parse(process.argv[5]);fs.writeFileSync(a.screenshot_out_file,Buffer.from('${png}','base64'));process.stdout.write(JSON.stringify({screenshot_file_path:a.screenshot_out_file}));\n`);
await chmod(driver, 0o700);

const leases = new Map<string, Record<string, unknown>>();
const guestRoots = new Set<string>();
const log = (entry: unknown) => appendFile(join(root, 'requests.jsonl'), `${JSON.stringify(entry)}\n`);
const respond = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  const body: any = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const path = req.url!;
  await log({ at: new Date().toISOString(), method: req.method, path, body });
  if (path === '/health') return respond(res, 200, { ok: true, service: 'machine-service' });
  if (path === '/images') return respond(res, 200, { images: { ubuntu2404: { kind: 'linux', base_available: true } }, capacity: { macos_running: 0, macos_limit: 2 } });
  if (path === '/applications') return respond(res, 200, { schemaVersion: 1, images: [{ image: 'ubuntu2404', os: 'linux', architecture: 'arm64', applications: [{ id: 'firefox', name: 'Firefox', aliases: [], version: '128.0' }, { id: 'dpkg:cua-driver', name: 'cua-driver', aliases: [], version: '1.0' }] }] });
  if (path === '/machines') return respond(res, 200, { machines: Object.fromEntries(leases), limits: { max_macos_running: 2, grace_hours: 1 }, pilot_repo: root, port: 0 });
  if (path === '/acquire') {
    const vm = `fixture-${randomUUID()}`;
    const lease = { vm, purpose: body.purpose, image: body.image, image_kind: 'linux', env: body.env, state: 'running', created_at: Date.now() / 1000, ttl_expires_at: Date.now() / 1000 + body.ttl_hours * 3600, grace_until: null, warned: false, ip: null, cpu: null, memory_mb: null, disk_gb: null };
    leases.set(vm, lease);
    return respond(res, 200, lease);
  }
  const match = /^\/machines\/([^/]+)(?:\/(exec|push|pull|heartbeat|release))?$/.exec(path);
  if (!match || !leases.has(match[1]!)) return respond(res, 404, { error: 'not found' });
  const vm = match[1]!, lease = leases.get(vm)!;
  if (!match[2]) return respond(res, 200, lease);
  if (match[2] === 'heartbeat') return respond(res, 200, { ...lease, ttl_hours_remaining: body.ttl_hours });
  if (match[2] === 'release') { leases.delete(vm); return respond(res, 200, { vm, released: true, reason: body.reason }); }
  if (match[2] === 'push') { await copyFile(body.local_path, body.remote_path); return respond(res, 200, { vm, pushed: body.local_path, to: body.remote_path }); }
  if (match[2] === 'pull') { await copyFile(body.remote_path, body.local_path); return respond(res, 200, { vm, pulled: body.remote_path, to: body.local_path }); }
  const argv: string[] = body.argv;
  if (!['node', process.execPath, '/bin/mkdir', '/usr/bin/env'].includes(argv[0]!)) return respond(res, 400, { error: `Unexpected fixture executable: ${argv[0]}` });
  if (argv[0] === '/bin/mkdir') for (const dir of argv.slice(2)) { const m = /^(\/var\/tmp\/[^/]+-mcp-relay-[^/]+)(?:\/|$)/.exec(dir); if (m) guestRoots.add(m[1]!); }
  const response = await new Promise<{ rc: number; output: string }>((done, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: root, env: { PATH: process.env.PATH!, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    child.on('error', reject); child.on('close', code => done({ rc: code ?? 1, output }));
  });
  return respond(res, 200, { vm, ...response, output: response.output.slice(-64000) });
}

const server = createServer((req, res) => { void handle(req, res).catch(error => respond(res, 500, { error: String(error) })); });
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await writeFile(infoFile, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, port: address.port, root: resolve(root), driver, node: process.execPath }));
});
const shutdown = async () => {
  server.close();
  for (const guest of guestRoots) {
    await rm(guest, { recursive: true, force: true });
  }
  process.exit(0);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
