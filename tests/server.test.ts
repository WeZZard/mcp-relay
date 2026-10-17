import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { instructions, relayTools } from '../src/core.js';
import type { RelayManager } from '../src/manager.js';
import { PLUGIN_TOOL_PREFIX, STATUS_TOOL, createRelayServer, projectDirectory, relayContent } from '../src/server.js';

const run = promisify(execFile);
const server = resolve('dist/server.mjs');
const allToolNames = [...relayTools.map(tool => tool.name), STATUS_TOOL];
const runTools = ['relay_exec', 'relay_script', 'relay_code', 'relay_run'];

test('the project directory comes from the plugin, unless the placeholder was never expanded', () => {
  assert.equal(projectDirectory({ MCP_RELAY_PROJECT: '/tmp/project' }, '/elsewhere'), '/tmp/project');
  assert.equal(projectDirectory({ MCP_RELAY_PROJECT: '${CLAUDE_PROJECT_DIR}' }, '/elsewhere'), '/elsewhere');
  assert.equal(projectDirectory({}, '/elsewhere'), '/elsewhere');
  // The project's earlier name is not read (DC-16).
  assert.equal(projectDirectory({ MCP_VM_RELAY_PROJECT: '/tmp/project' }, '/elsewhere'), '/elsewhere');
});

test('the server refuses to start on a guest network other than nat or internet (DC-17)', async () => {
  await assert.rejects(run(process.execPath, [server], { env: { ...process.env, MCP_RELAY_GUEST_NETWORK: 'host' } }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /MCP_RELAY_GUEST_NETWORK must be nat or internet, not "host"/);
    return true;
  });
});

test('the server refuses to start on a capacity wait that is not whole seconds (DC-22)', async () => {
  for (const value of ['', '-1', '1.5', '30m']) {
    await assert.rejects(run(process.execPath, [server], { env: { ...process.env, MCP_RELAY_CAPACITY_WAIT: value } }), (error: any) => {
      assert.equal(error.code, 1, value);
      assert.match(error.stderr, /MCP_RELAY_CAPACITY_WAIT must be a nonnegative integer of seconds/, value);
      return true;
    });
  }
});

test('the server refuses to start on an exit behaviour other than pause or release (DC-21)', async () => {
  for (const value of ['', 'destroy', 'Release']) {
    await assert.rejects(run(process.execPath, [server], { env: { ...process.env, MCP_RELAY_ON_EXIT: value } }), (error: any) => {
      assert.equal(error.code, 1, value);
      assert.match(error.stderr, /MCP_RELAY_ON_EXIT must be pause or release/, value);
      return true;
    });
  }
});

test('the server refuses to start on a guest limit that is not a positive integer (DC-20)', async () => {
  for (const value of ['0', '-1', '2.5', 'four', '']) {
    await assert.rejects(run(process.execPath, [server], { env: { ...process.env, MCP_RELAY_MAX_GUESTS: value } }), (error: any) => {
      assert.equal(error.code, 1, value);
      assert.match(error.stderr, /MCP_RELAY_MAX_GUESTS must be a positive integer/, value);
      return true;
    });
  }
});

test('no text tells the agent to relay only interruptive work (DC-14)', async () => {
  const rule = /interrupt|non-disruptive|headless work|stays with local tools|unknown is not idle/i;
  assert.doesNotMatch(instructions, rule);
  assert.doesNotMatch(relayTools.find(tool => tool.name === 'relay_probe')!.description, rule);
  assert.doesNotMatch(await readFile('agents/vm-relay-operator.md', 'utf8'), rule);
  assert.doesNotMatch((await readFile('README.md', 'utf8')).split('## How it is built')[0]!, rule);
});

test('the CLI prints the instructions text and the full table of tool schemas', async () => {
  const { stdout } = await run(process.execPath, [server, '--instructions']);
  assert.equal(stdout, `${instructions}\n`);
  assert.match(stdout, /relay_probe/);
  assert.match(stdout, /relay_acquire/);
  assert.match(stdout, /after-image is returned as pending and downloaded in the background, so call relay_image with the imageId/);
  const schema = JSON.parse((await run(process.execPath, [server, '--schema'])).stdout);
  assert.deepEqual(schema.map((tool: any) => tool.name).sort(), [...allToolNames].sort());
  for (const tool of schema) {
    assert.ok(tool.title?.length > 0, tool.name);
    assert.ok(tool.annotations, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
  }
  await assert.rejects(run(process.execPath, [server, '--nonsense']), /Usage/);
});

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-')));
  const project = join(root, 'project'); await mkdir(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: {
    ...process.env as Record<string, string>,
    MCP_RELAY_PROJECT: project, MCP_RELAY_SESSION: 'test-session',
    HOME: root, // no ~/AGENTS.md here: the relay keeps a private registry in its own state directory
    MCP_RELAY_STATE_DIR: join(root, 'state'),
    MCP_RELAY_URL: 'http://127.0.0.1:9', // nothing listens: every service call fails fast and visibly
  } });
  const client = new Client({ name: 'mcp-relay-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { root, project, client };
}

test('over stdio the server offers exactly the nineteen tools, each with a title, annotations and a plain-object schema with no root combinator', async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...allToolNames].sort());
  for (const tool of tools) {
    assert.ok(tool.title && tool.title.length > 0, tool.name);
    assert.ok(tool.annotations, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal((tool.inputSchema as any).additionalProperties, false, tool.name);
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) assert.ok(!(combinator in tool.inputSchema), `${tool.name} has a root ${combinator}`);
    assert.ok(!('action' in ((tool.inputSchema.properties as object) ?? {})), `${tool.name} exposes action`);
  }
  for (const name of ['relay_search', 'relay_probe', 'relay_acquisition_capabilities', 'relay_image', 'relay_console_resolve', STATUS_TOOL]) {
    const annotations = tools.find(tool => tool.name === name)!.annotations!;
    assert.equal(annotations.readOnlyHint, true, name); assert.equal(annotations.idempotentHint, true, name);
  }
  for (const name of ['relay_finish', 'relay_release']) assert.equal(tools.find(tool => tool.name === name)!.annotations!.destructiveHint, true, name);
  for (const name of tools.map(tool => tool.name)) {
    const annotations = tools.find(tool => tool.name === name)!.annotations!;
    assert.equal(annotations.openWorldHint, runTools.includes(name), name);
  }
});

test('each run tool maps to its own kind in the derived schema, without a kind field', async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  for (const [name, argField] of [['relay_exec', 'argv'], ['relay_script', 'localPath'], ['relay_code', 'code']] as const) {
    const tool = tools.find(t2 => t2.name === name)!;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    assert.ok(argField in properties, `${name} carries its own field ${argField}`);
    assert.ok(!('kind' in properties), `${name} does not expose kind`);
    assert.ok('reason' in properties && 'step' in properties && 'snapshots' in properties, `${name} carries the shared run fields`);
    assert.ok(!(tool.inputSchema.required ?? []).some(key => ['reason', 'step', 'snapshots'].includes(key)), `${name} requires no evidence field`);
  }
  const relayRun = tools.find(t2 => t2.name === 'relay_run')!;
  assert.deepEqual(Object.keys(relayRun.inputSchema.properties as object).sort(), ['afterIntervalMs', 'args', 'expected', 'guest', 'hold', 'reason', 'target', 'timeoutMs', 'tool']);
  assert.deepEqual(relayRun.inputSchema.required, ['guest', 'target', 'tool']);
  const relayToolsTool = tools.find(t2 => t2.name === 'relay_tools')!;
  assert.deepEqual(relayToolsTool.inputSchema.required, ['guest', 'target']);
  // Every tool that acts on a guest requires its name (DC-20).
  for (const name of ['relay_stage', 'relay_exec', 'relay_script', 'relay_code', 'relay_run', 'relay_gate', 'relay_tools', 'relay_image', 'relay_extract', 'relay_finish', 'relay_release', 'relay_console_resolve', 'relay_console_open', 'relay_console_cancel']) assert.ok((tools.find(t2 => t2.name === name)!.inputSchema.required ?? []).includes('guest'), name);
  for (const name of ['relay_search', 'relay_probe', 'relay_acquisition_capabilities', 'relay_acquire']) assert.ok(!(tools.find(t2 => t2.name === name)!.inputSchema.required ?? []).includes('guest'), name);
  assert.ok(!tools.some(t2 => ['relay_cua', 'relay_browser'].includes(t2.name)));
});

test('invalid input is refused by the strict contract before any manager exists; status stays inactive', async t => {
  const { client, root, project } = await fixture(t);
  // relay_acquire takes no network from the agent (DC-17).
  for (const [name, args] of [['relay_probe', { reason: 'no' }], ['relay_exec', {}], ['relay_acquire', {}], ['relay_acquire', { task: 'net', image: 'ubuntu2404', extractions: [], network: 'internet' }], ['relay_run', { target: 'firefox', tool: 'x' }], ['relay_tools', {}]] as const) {
    const result: any = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, /Invalid relay input/);
  }
  const unknown: any = await client.callTool({ name: 'relay_dance', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown tool/);
  const status: any = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  assert.equal(status.isError, false); assert.deepEqual(JSON.parse(status.content[0].text), { active: false, guests: [], maxGuests: 4, project, service: 'http://127.0.0.1:9' });
  await assert.rejects(stat(join(root, 'state')), { code: 'ENOENT' }); // nothing was created for refused calls
});

test('a valid call that reaches an unreachable service is an error result, not a crash', async t => {
  const { client } = await fixture(t);
  const result: any = await client.callTool({ name: 'relay_search', arguments: { name: 'Firefox' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /vm-service \/applications: request failed/);
  const status: any = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).active, false);
});

test('the server offers no MCP prompts: the user commands are host command files', async t => {
  const { client } = await fixture(t);
  assert.equal(client.getServerCapabilities()?.prompts, undefined);
  await assert.rejects(client.listPrompts(), /Method not found/);
});

test('cancelling a relay call from the client aborts the server-side signal', async t => {
  let capturedSignal: AbortSignal | undefined;
  let started: () => void;
  const ran = new Promise<void>(resolve => { started = resolve; });
  const fakeManager = {
    run: async (_input: unknown, signal?: AbortSignal) => {
      capturedSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('run aborted')));
      });
    },
  } as unknown as RelayManager;
  const relay = createRelayServer({ project: '/tmp', manager: () => fakeManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await relay.server.connect(serverTransport);
  t.after(() => relay.server.close());
  const client = new Client({ name: 'mcp-relay-cancel-test', version: '0' });
  await client.connect(clientTransport);
  t.after(() => client.close());

  const controller = new AbortController();
  const step = { id: 'step', title: 'Fixture', expected: 'Completes', inputMode: 'ordinary' };
  const callPromise = client.callTool(
    { name: 'relay_exec', arguments: { guest: 'cancel-1', reason: 'Exercise client-initiated cancellation', argv: ['node', '--version'], step, snapshots: { afterIntervalMs: 0 } } },
    undefined,
    { signal: controller.signal },
  );
  await ran;
  assert.equal(capturedSignal?.aborted, false);
  controller.abort();
  await assert.rejects(callPromise);
  assert.equal(capturedSignal?.aborted, true);
});

test('the server dispatches calls on different guests at the same time (DC-20)', async t => {
  // Each run waits until both are running: only concurrent dispatch lets either finish.
  const running: string[] = []; let both!: () => void;
  const together = new Promise<void>(resolve => { both = resolve; });
  const fakeManager = {
    run: async (input: { guest: string }) => {
      running.push(input.guest); if (running.length === 2) both();
      await together;
      return { executionId: input.guest, outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } };
    },
  } as unknown as RelayManager;
  const relay = createRelayServer({ project: '/tmp', manager: () => fakeManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await relay.server.connect(serverTransport);
  t.after(() => relay.server.close());
  const client = new Client({ name: 'mcp-relay-concurrency-test', version: '0' });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const call = (guest: string) => client.callTool({ name: 'relay_exec', arguments: { guest, argv: ['true'] } }) as Promise<any>;
  const results = await Promise.race([Promise.all([call('first-1'), call('second-1')]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the two calls were not dispatched together')), 5000).unref())]);
  assert.deepEqual(running.sort(), ['first-1', 'second-1']);
  for (const result of results) assert.equal(result.isError, false, result.content[0].text);
});

test('the plugin files name the server the tests spoke to and ship the built bundles', async () => {
  const mcp = JSON.parse(await readFile('.mcp.json', 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['relay']);
  assert.deepEqual(mcp.mcpServers['relay'].args, ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
  const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'));
  assert.equal(plugin.name, 'mcp-relay');
  assert.equal(plugin.repository, 'https://github.com/WeZZard/mcp-relay');
  assert.deepEqual(mcp.mcpServers['relay'].env, { MCP_RELAY_PROJECT: '${CLAUDE_PROJECT_DIR}' });
  assert.equal(PLUGIN_TOOL_PREFIX, `mcp__plugin_${plugin.name}_relay__`);
  const agent = await readFile('agents/vm-relay-operator.md', 'utf8');
  for (const tool of relayTools) assert.match(agent, new RegExp(`${PLUGIN_TOOL_PREFIX}${tool.name}(?![A-Za-z0-9_])`), tool.name);
  assert.match(agent, new RegExp(`${PLUGIN_TOOL_PREFIX}${STATUS_TOOL}(?![A-Za-z0-9_])`));
  for (const name of ['server.mjs', 'receiver.mjs', 'mcp-host.mjs', 'doctor.mjs', 'integrity.json', 'build-info.json', 'NOTICE.txt']) assert.ok((await stat(join('dist', name))).isFile(), name);
  const bundle = await readFile('dist/server.mjs', 'utf8');
  assert.doesNotMatch(bundle, /@earendil-works/);
  const info = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
  assert.deepEqual(info.packages.map((p: any) => p.name).sort(), ['@wezzard/relay-driver-core', '@wezzard/relay-driver-host-sdk', '@wezzard/relay-driver-remote-runtime']);
});

test('an image-bearing relay result becomes MCP content: the text block, then the typed image block, with the error flag preserved', () => {
  const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
  assert.deepEqual(relayContent({ text: 'identity\n{}', details: {}, isError: false, image }), { content: [{ type: 'text', text: 'identity\n{}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false });
  assert.deepEqual(relayContent({ text: 'failed', details: {}, isError: true, image }), { content: [{ type: 'text', text: 'failed' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true });
  assert.deepEqual(relayContent({ text: '{}', details: {}, isError: false }), { content: [{ type: 'text', text: '{}' }], isError: false });
  // relay_run: the target tool's own blocks sit between the relay's text and the after-snapshot.
  const tool = { type: 'image' as const, data: 'BBBB', mimeType: 'image/jpeg' };
  assert.deepEqual(relayContent({ text: 'relay', details: {}, isError: true, image, content: [{ type: 'text', text: 'tool text' }, tool] }).content,
    [{ type: 'text', text: 'relay' }, { type: 'text', text: 'tool text' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
});
