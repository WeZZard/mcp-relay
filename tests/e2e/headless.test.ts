/**
 * End-to-end: headless Claude Code (`claude --print`) with this plugin loaded
 * from disk, driving the relay through the plugin's own MCP server against a
 * loopback stand-in for vm-service. What is checked is what happened on disk
 * and at the service, not what the model said. Needs `claude` on PATH and an
 * account; spends a few model turns per case. Run with `npm run test:e2e`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { verifyDeliveredPackage } from '../../src/package.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'mcp__plugin_mcp-relay_relay__';
const TOOL = /^mcp__(?:plugin_mcp-relay_)?relay__relay_[a-z_]+$/;
/** The plugin-scoped Claude Code name of one relay tool. */
const tool = (name: string) => PREFIX + name;
const STATUS = tool('relay_status');
const registryText = '# Test registry\n\n## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n| foreign | linux | keep-me | another agent | /project | yesterday |\n\n## End\nUnrelated text.\n';
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const hasClaude = await new Promise<boolean>(done => { const child = spawn('claude', ['--version'], { stdio: 'ignore' }); child.on('error', () => done(false)); child.on('close', code => done(code === 0)); });
const skip = hasClaude ? false : 'claude is not on PATH';

interface ToolUse { name: string; input: any }
interface ToolResult { text: string; isError: boolean }
interface Run { code: number | null; events: any[]; toolUses: ToolUse[]; toolResults: ToolResult[]; result?: any; stderr: string }

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-e2e-')));
  const project = join(root, 'project'); await mkdir(project);
  const registryPath = join(root, 'AGENTS.md'); await writeFile(registryPath, registryText);
  const infoFile = join(root, 'service.json');
  const service = spawn(process.execPath, [join(repo, 'node_modules', '.bin', 'tsx'), join(repo, 'tests', 'e2e', 'fixture-service.ts'), root, infoFile], { stdio: ['ignore', 'inherit', 'inherit'] });
  t.after(async () => { service.kill('SIGTERM'); await new Promise(done => { service.on('close', done); setTimeout(done, 8000); }); await rm(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 15000; let info: any;
  while (!info && Date.now() < deadline) { try { info = JSON.parse(await readFile(infoFile, 'utf8')); } catch { await sleep(50); } }
  assert.ok(info, 'fixture service did not start');
  const env = { MCP_RELAY_URL: info.url, MCP_RELAY_STATE_DIR: join(root, 'state'), MCP_RELAY_REGISTRY: registryPath, MCP_RELAY_SESSION: `e2e-${t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` };
  const requests = async () => (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, project, registryPath, info, env, requests };
}

/** One headless run: the prompt on stdin, the plugin from this checkout, only the relay tools allowed, the service pointed at the fixture. */
function claude(project: string, prompt: string, env: Record<string, string>, maxTurns = 40): Promise<Run> {
  return new Promise((done, reject) => {
    const args = ['--print', '--plugin-dir', repo, '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns),
      '--settings', JSON.stringify({ env }), '--allowedTools', `${PREFIX}*`];
    const child: ChildProcess = spawn('claude', args, { cwd: project, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      const events = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      // Claude Code defers MCP tool schemas: the model first loads the relay tools
      // through its built-in ToolSearch. Only the relay tools' calls and their
      // results (paired by id) are what these cases judge.
      const toolUses: ToolUse[] = [], toolResults: ToolResult[] = [], names = new Map<string, string>();
      for (const event of events) {
        const content = event.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          // A tool call whose arguments never parsed is recorded by Claude Code with
          // an __unparsedToolInput marker and never executed; the model then retries.
          if (block.type === 'tool_use' && block.input && typeof block.input === 'object' && '__unparsedToolInput' in block.input) continue;
          if (block.type === 'tool_use') { names.set(block.id, block.name); if (TOOL.test(block.name)) toolUses.push({ name: block.name, input: block.input }); }
          if (block.type === 'tool_result' && TOOL.test(names.get(block.tool_use_id) ?? '')) toolResults.push({ isError: block.is_error === true, text: typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('') });
        }
      }
      done({ code, events, toolUses, toolResults, result: events.find(e => e.type === 'result'), stderr });
    });
    child.stdin!.end(prompt);
  });
}

const stepJson = (value: unknown) => JSON.stringify(value);

test('status: the plugin loads, its tools carry the plugin-scoped names, and the server talks to the fixture service', { skip, timeout: 300_000 }, async t => {
  const f = await fixture(t);
  const run = await claude(f.project, 'Call the relay_status tool once, with no arguments, and reply with exactly the JSON it returned and nothing else.', f.env, 4);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.toolUses.length >= 1, `no relay tool call in ${JSON.stringify(run.result)}`);
  assert.equal(run.toolUses[0]!.name, STATUS, 'the tool carries the plugin-scoped name');
  const status = JSON.parse(run.toolResults[0]!.text);
  assert.equal(status.active, false);
  assert.equal(status.service, f.info.url, 'the server must be pointed at the fixture, never a real vm-service');
  assert.equal(status.project, f.project);
});

test('refusal: an invalid relay call is an error result from the strict contract, reported without a crash', { skip, timeout: 300_000 }, async t => {
  const f = await fixture(t);
  const run = await claude(f.project, `Call the relay_run tool exactly once with the arguments ${stepJson({ target: 'firefox', tool: 'x' })}. It will fail; that is expected. Reply with the error text you received and nothing else. Do not retry.`, f.env, 4);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.toolUses.length, 1); assert.equal(run.toolUses[0]!.name, tool('relay_run'));
  assert.equal(run.toolResults[0]!.isError, true);
  assert.match(run.toolResults[0]!.text, /Invalid relay input|firefox/);
  assert.deepEqual(await f.requests(), [], 'invalid input never reaches the service');
});

test('lifecycle: acquire, stage, run one exec, finish; the verified package and the artifact land in the project and the lease is released', { skip, timeout: 600_000 }, async t => {
  const f = await fixture(t);
  const steps: Array<[string, unknown]> = [
    ['relay_acquire', { task: 'e2e-exec', image: 'ubuntu2404', extractions: [{ path: 'artifact.txt', name: 'artifact' }] }],
    ['relay_stage', { nodePath: f.info.node, cuaDriver: f.info.driver }],
    ['relay_exec', { reason: 'End-to-end fixture run; no real desktop is touched', argv: [f.info.node, '-e', "require('fs').writeFileSync('artifact.txt','headless package')"], step: { id: 'write', title: 'Write the artifact', expected: 'artifact.txt exists in the workspace', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } }],
    ['relay_finish', {}],
  ];
  const prompt = `You are exercising the relay plugin against a fixture service. Make exactly these four tool calls, in this order, one at a time, passing each JSON object as the arguments verbatim:\n${steps.map(([name, args], i) => `${i + 1}. ${name} with ${stepJson(args)}`).join('\n')}\nDo not call any other tool and do not change the arguments. When the fourth call has returned, reply with the single word DONE.`;
  const run = await claude(f.project, prompt, f.env, 12);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.toolUses.map(u => u.name), steps.map(([name]) => tool(name)), JSON.stringify(run.toolUses));
  for (const result of run.toolResults) assert.equal(result.isError, false, result.text);
  const packages = (await readdir(join(f.project, 'relay-evidence'))).filter(name => name.startsWith('relay-e2e-exec-') && !name.includes('.'));
  assert.equal(packages.length, 1, 'one evidence package');
  const dir = join(f.project, 'relay-evidence', packages[0]!);
  const verified = await verifyDeliveredPackage(dir);
  assert.equal(verified.deliveryVerified, true, JSON.stringify(verified));
  assert.equal(verified.execution, 'passed');
  const copies = await readdir(join(dir, 'extractions', 'artifact'));
  assert.equal(await readFile(join(dir, 'extractions', 'artifact', copies[0]!), 'utf8'), 'headless package');
  const requests = await f.requests();
  assert.ok(requests.some(r => r.path === '/acquire'));
  assert.equal(requests.find(r => r.path.endsWith('/release'))?.body.reason, 'finished');
  assert.equal(await readFile(f.registryPath, 'utf8'), registryText, 'the registry row was added and removed again');
  const lifecycle = JSON.parse(await readFile(`${dir}.lifecycle.json`, 'utf8'));
  assert.equal(lifecycle.released, true);
});

test('abandoned lease: a session that acquires and stops without finishing keeps its VM; renewal pauses and the lease waits for an explicit release or the service TTL', { skip, timeout: 600_000 }, async t => {
  const f = await fixture(t);
  const prompt = `This is a cleanup test. Make exactly one relay_acquire tool call with the arguments ${stepJson({ task: 'e2e-abandon', image: 'ubuntu2404', extractions: [] })}. Then reply with the single word DONE. Do not call finish, release or any other tool: the test is checking what happens when a session ends with a lease still held.`;
  const run = await claude(f.project, prompt, f.env, 4);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.toolUses.map(u => u.name), [tool('relay_acquire')], JSON.stringify(run.toolUses));
  assert.equal(run.toolResults[0]!.isError, false, run.toolResults[0]!.text);
  // The session ended when claude exited; the server paused renewal and detached rather than destroying the VM.
  await sleep(2000);
  const requests = await f.requests();
  assert.ok(requests.some(r => r.path === '/acquire'));
  assert.equal(requests.find(r => r.path.endsWith('/release')), undefined, 'session end must not release: the VM is retained for an explicit finish or release, and the vm-service TTL is the backstop');
  const entries = await readdir(join(f.project, 'relay-evidence'));
  const purpose = entries.find(name => name.startsWith('relay-e2e-abandon-') && !name.includes('.'));
  assert.ok(purpose, entries.join(','));
  const events = await Promise.all((await readdir(join(f.project, 'relay-evidence', purpose!, 'host', 'events'))).map(async name => JSON.parse(await readFile(join(f.project, 'relay-evidence', purpose!, 'host', 'events', name), 'utf8'))));
  const paused = events.find(event => event.kind === 'renewal-paused');
  assert.ok(paused, JSON.stringify(events.map(event => event.kind)));
  assert.match(paused.details.reason, /session/i);
  assert.equal(typeof paused.details.expiresAt, 'number');
  assert.notEqual(await readFile(f.registryPath, 'utf8'), registryText, 'ownership stays registered until the lease is finished or released');
  assert.match(await readFile(f.registryPath, 'utf8'), new RegExp(purpose!));
});
