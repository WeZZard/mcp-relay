import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { relayCall, relayJsonSchema, relayResultKind, relayToolInput, relayToolInputSchema, relayTools } from '../src/surface.js';
import { relayActions } from '../src/schema.js';
import type { RelayManager } from '../src/manager.js';

/** Every local module reachable from the core entry, by following relative imports. */
async function reachable(entry: string): Promise<string[]> {
  const seen = new Set<string>(); const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) queue.push(resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts')));
  }
  return [...seen];
}

test('nothing reachable from the core imports an agent runtime: the relay is plain Node', async () => {
  const files = await reachable('src/core.ts');
  assert.ok(files.some(f => f.endsWith('/manager.ts')) && files.some(f => f.endsWith('/schema.ts')) && files.some(f => f.endsWith('/surface.ts')));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /@earendil-works/, `${file} imports pi`);
  }
  assert.ok(!files.some(f => f.endsWith('/server.ts')), 'the core does not depend on the MCP front end');
});

test('the built bundles carry no agent-runtime dependency and are all listed with their hashes', async () => {
  const integrity = JSON.parse(await readFile('dist/integrity.json', 'utf8'));
  assert.deepEqual(Object.keys(integrity).sort(), ['doctor.mjs', 'receiver.mjs', 'review-data.mjs', 'server.mjs']);
  for (const name of Object.keys(integrity)) {
    const bundle = await readFile(join('dist', name), 'utf8');
    assert.doesNotMatch(bundle, /@earendil-works/, name);
    assert.doesNotMatch(bundle, /pi-vm-relay\/core/, name);
  }
  assert.ok((await stat('dist/NOTICE.txt')).isFile());
});

test('the JSON schema names every action and carries the strict branches; symbol keys are gone', () => {
  const schema = relayJsonSchema();
  assert.equal(schema.type, 'object');
  assert.deepEqual((schema.properties as any).action.enum, [...relayActions]);
  assert.equal((schema.anyOf as unknown[]).length, 13); // thirteen actions, one branch each (DC-26)
  assert.equal(Object.getOwnPropertySymbols(schema).length, 0);
});

test('the thirteen action-backed relay_* tools each derive a plain-object schema with no action, no kind and no root combinator', () => {
  assert.equal(relayTools.length, 13);
  assert.deepEqual(relayTools.map(t => t.name), [...new Set(relayTools.map(t => t.name))], 'tool names are unique');
  for (const tool of relayTools) {
    assert.match(tool.name, /^relay_[a-z_]+$/);
    assert.ok(tool.title.length > 0, `${tool.name} has a title`);
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    const schema = relayToolInputSchema(tool);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) assert.ok(!(combinator in schema), `${tool.name} has a root ${combinator}`);
    assert.ok(!('action' in (schema.properties as object)), `${tool.name} exposes action`);
    assert.ok(!('kind' in (schema.properties as object)), `${tool.name} exposes kind`);
  }
  const runTools = relayTools.filter(t => t.action === 'run');
  assert.deepEqual(runTools.map(t => t.name), ['relay_script'], 'one run tool (DC-26)');
  for (const name of ['relay_command', 'relay_exec', 'relay_code', 'relay_run', 'relay_gate', 'relay_tools', 'relay_cua', 'relay_browser']) assert.ok(!relayTools.some(t => t.name === name), `${name} is gone (DC-23, DC-26)`);
  const scriptSchema = relayToolInputSchema(relayTools.find(t => t.name === 'relay_script')!);
  assert.deepEqual(scriptSchema.required, ['guest', 'language', 'inline']);
  assert.deepEqual(Object.keys(scriptSchema.properties as object).sort(), ['code', 'diagnostic', 'guest', 'inline', 'language', 'localPath', 'reason', 'snapshots', 'step', 'timeoutMs']);
  assert.deepEqual((scriptSchema.properties as any).language.enum, ['shell', 'javascript', 'typescript', 'python']);
  assert.ok(!(scriptSchema.required as string[]).some(key => ['reason', 'step', 'snapshots', 'diagnostic'].includes(key)), 'relay_script requires no evidence field and no diagnostic');
});

test('relayToolInput maps each tool name back to the action shape relayCall dispatches, e.g. relay_script becomes action=run with no kind', () => {
  assert.deepEqual(relayToolInput('relay_search', { name: 'Firefox' }), { action: 'search', name: 'Firefox' });
  assert.deepEqual(relayToolInput('relay_probe', { scope: 'guest' }), { action: 'probe', scope: 'guest' });
  assert.deepEqual(relayToolInput('relay_script', { language: 'python', inline: true, code: 'print(1)' }), { action: 'run', language: 'python', inline: true, code: 'print(1)' });
  for (const name of ['relay_command', 'relay_exec', 'relay_code', 'relay_run', 'relay_gate', 'relay_tools']) assert.throws(() => relayToolInput(name, {}), /Unknown relay tool/, name);
  assert.deepEqual(relayToolInput('relay_finish', {}), { action: 'finish' });
  assert.throws(() => relayToolInput('relay_dance', {}), /Unknown relay tool/);
});

function fakeManager(run: unknown, image?: unknown): RelayManager {
  const calls: unknown[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push({ [name]: args }); return { [name]: true }; };
  return { calls, probe: async (scope?: string, guest?: string) => ({ probed: true, ...(scope ? { scope } : {}), ...(guest ? { guest } : {}) }), release: async () => ({ active: false }),
    run: async (input: unknown) => { calls.push(input); return run; }, image: async (target: unknown) => { calls.push({ image: target }); return image; },
    acquisitionCapabilities: record('acquisitionCapabilities'), consoleResolve: record('consoleResolve'), consoleOpen: record('consoleOpen'), consoleCancel: record('consoleCancel') } as unknown as RelayManager;
}
const step = { id: 'step', title: 'Fixture', expected: 'Completes', inputMode: 'ordinary' };
const run = { action: 'run', guest: 'core-1', reason: 'Exercise dispatch without a VM', language: 'shell', inline: true, code: 'node --version', step, snapshots: { afterIntervalMs: 0 } };

test('relayCall validates, dispatches by action, and flags a refused, uncertain or nonzero run as an error result', async () => {
  let obtained = 0;
  await assert.rejects(relayCall(() => { obtained++; return fakeManager({}); }, { action: 'dance' }), /Invalid relay input/);
  assert.equal(obtained, 0); // invalid input never obtains a manager
  // The evidence fields are optional; a bare shell script is valid and the manager derives the record.
  const bare = fakeManager({ executionId: 'x', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } });
  assert.equal((await relayCall(bare, { action: 'run', guest: 'core-1', language: 'shell', inline: true, code: 'true' })).isError, false);
  assert.deepEqual((bare as any).calls[0], { guest: 'core-1', language: 'shell', inline: true, code: 'true' });
  await assert.rejects(relayCall(bare, { action: 'run', language: 'shell', inline: true, code: 'true' }), /Invalid relay input/, 'a run names its guest (DC-20)');
  for (const kind of ['exec', 'script', 'code']) await assert.rejects(relayCall(fakeManager({}), { action: 'run', kind, guest: 'core-1', language: 'shell', inline: true, code: 'true' }), /Invalid relay input/, `a run takes no kind, ${kind} included (DC-26)`);
  await assert.rejects(relayCall(fakeManager({}), { action: 'run', guest: 'core-1', argv: ['true'] }), /Invalid relay input/, 'a command is a shell script, not argv (DC-26)');
  await assert.rejects(relayCall(fakeManager({}), { action: 'run', kind: 'mcp', guest: 'core-1', target: 'cua', tool: 'x' }), /Invalid relay input/);
  await assert.rejects(relayCall(fakeManager({}), { action: 'gate', guest: 'core-1', hold: 'h', decision: 'go' }), /Invalid relay input/);
  await assert.rejects(relayCall(fakeManager({}), { action: 'run', kind: 'code', guest: 'core-1', language: 'python', code: 'print(1)' }), /Invalid relay input/);
  await assert.rejects(relayCall(fakeManager({}), { action: 'run', guest: 'core-1', language: 'shell', inline: true, code: 'true', diagnostic: true, snapshots: { group: { groupId: 'g', phase: 'first' } } }), /Diagnostic scripts cannot join/);
  for (const language of ['javascript', 'typescript', 'python']) await assert.rejects(relayCall(fakeManager({}), { action: 'run', guest: 'core-1', language, inline: true, code: '1', diagnostic: true }), /only a shell script may be diagnostic/, language);
  const diagnostic = fakeManager({ executionId: 'd', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } });
  assert.equal((await relayCall(diagnostic, { action: 'run', guest: 'core-1', language: 'shell', inline: false, localPath: 'repair.sh', diagnostic: true })).isError, false);
  assert.deepEqual((diagnostic as any).calls[0], { guest: 'core-1', language: 'shell', inline: false, localPath: 'repair.sh', diagnostic: true });
  const probe = await relayCall(fakeManager({}), { action: 'probe' });
  assert.deepEqual(probe, { text: JSON.stringify({ probed: true }, null, 2), details: { probed: true }, isError: false });
  const completed = await relayCall(fakeManager({ executionId: 'x', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } }), run);
  assert.equal(completed.isError, false);
  for (const outcome of [{ kind: 'refused', diagnostic: 'capture unavailable' }, { kind: 'uncertain', diagnostic: 'lost response' }, { kind: 'completed', exitStatus: { code: 7, signal: null } }, { kind: 'completed', exitStatus: { code: 0, signal: 'SIGKILL' } }]) {
    const manager = fakeManager({ executionId: 'x', outcome });
    const result = await relayCall(manager, run);
    assert.equal(result.isError, true, JSON.stringify(outcome));
    assert.match(result.text, new RegExp(outcome.kind));
    assert.deepEqual(Object.keys((manager as any).calls[0]).sort(), ['because', 'code', 'guest', 'inline', 'language', 'snapshots', 'step']); // reason travels as because
  }
});

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO/8AAAAASUVORK5CYII=';
const image = { type: 'image' as const, data, mimeType: 'image/png' };
const completed = { executionId: 'execution-offline', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } };
const descriptor = { imageId: `image-${'a'.repeat(64)}`, source: 'display', enclosure: 'relay-x', sha256: 'b'.repeat(64), bytes: 68, mimeType: 'image/png' };

test('relay_script takes exactly the one of code and localPath that inline names; any other call is refused before the manager runs it', async () => {
  const ok = { executionId: 'x', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } } };
  const inline = fakeManager(ok);
  assert.equal((await relayCall(inline, { action: 'run', guest: 'core-1', language: 'python', inline: true, code: 'print(1)' })).isError, false);
  assert.deepEqual((inline as any).calls[0], { guest: 'core-1', language: 'python', inline: true, code: 'print(1)' });
  const file = fakeManager(ok);
  assert.equal((await relayCall(file, { action: 'run', guest: 'core-1', language: 'typescript', inline: false, localPath: 'tools/check.ts' })).isError, false);
  assert.deepEqual((file as any).calls[0], { guest: 'core-1', language: 'typescript', inline: false, localPath: 'tools/check.ts' });
  const base = { action: 'run', guest: 'core-1', language: 'javascript' };
  for (const bad of [{ ...base, inline: true }, { ...base, inline: true, localPath: 'a.js' }, { ...base, inline: true, code: '1', localPath: 'a.js' }, { ...base, inline: false }, { ...base, inline: false, code: '1' }, { ...base, inline: false, code: '1', localPath: 'a.js' }]) {
    const manager = fakeManager(ok);
    await assert.rejects(relayCall(manager, bad), /Invalid relay input: relay_script with inline/, JSON.stringify(bad));
    assert.deepEqual((manager as any).calls, [], 'a refused call never reaches the manager');
  }
  for (const bad of [{ ...base, code: '1' }, { ...base, localPath: 'a.js' }, { ...base, inline: 'yes', code: '1' }, { ...base, inline: true, code: '1', language: 'ruby' }, { ...base, inline: true, code: '1', diagnostic: true }]) {
    await assert.rejects(relayCall(fakeManager(ok), bad), /Invalid relay input/, JSON.stringify(bad));
  }
});

test('an image-bearing run carries the image as its own block with its identity leading the text; execution and delivery failures each flag an error without discarding it', async () => {
  const attached = { status: 'attached', image: descriptor, content: image, presentation: { width: 1, height: 1 } };
  const result = await relayCall(fakeManager({ ...completed, imageDelivery: attached }), run);
  assert.equal(result.isError, false);
  assert.deepEqual(result.image, image);
  assert.deepEqual(result.imageDelivery, { status: 'attached', image: descriptor, presentation: { width: 1, height: 1 } }, 'the delivery outcome travels without the bytes');
  const [identity, ...rest] = result.text.split('\n');
  assert.deepEqual(JSON.parse(identity), { imageDelivery: result.imageDelivery, executionFailed: false });
  assert.equal(JSON.parse(rest.join('\n')).executionId, 'execution-offline');
  assert.equal(rest.join('\n').includes(data), false, 'the bytes are not repeated in the text');
  assert.deepEqual(result.details, { kind: relayResultKind, isError: false, result: completed, imageDelivery: result.imageDelivery });
  const failedExecution = await relayCall(fakeManager({ ...completed, outcome: { kind: 'completed', exitStatus: { code: 7, signal: null } }, imageDelivery: attached }), run);
  assert.equal(failedExecution.isError, true); assert.deepEqual(failedExecution.image, image, 'a failed command keeps its after-image');
  assert.match(failedExecution.text, /"executionFailed":true/);
  for (const status of ['capture-failed', 'capture-unknown', 'transfer-failed', 'presentation-unavailable', 'stale-reference']) {
    const failedDelivery = await relayCall(fakeManager({ ...completed, imageDelivery: { status, diagnostic: 'fixture' } }), run);
    assert.equal(failedDelivery.isError, true, status); assert.equal(failedDelivery.image, undefined);
    assert.equal(failedDelivery.imageDelivery!.status, status);
  }
  const notRequested = await relayCall(fakeManager({ ...completed, imageDelivery: { status: 'not-requested', diagnostic: 'group member' } }), run);
  assert.equal(notRequested.isError, false); assert.equal(notRequested.image, undefined);
  const pending = await relayCall(fakeManager({ ...completed, imageDelivery: { status: 'pending', image: descriptor } }), run);
  assert.equal(pending.isError, false, 'a pending after-image is not an error'); assert.equal(pending.image, undefined);
  assert.deepEqual(JSON.parse(pending.text.split('\n')[0]), { imageDelivery: { status: 'pending', image: descriptor }, executionFailed: false }, 'the pending identity leads the text');
  const pendingFailed = await relayCall(fakeManager({ ...completed, outcome: { kind: 'completed', exitStatus: { code: 7, signal: null } }, imageDelivery: { status: 'pending', image: descriptor } }), run);
  assert.equal(pendingFailed.isError, true, 'a pending image does not hide a failed command');
  const legacy = await relayCall(fakeManager(completed), run);
  assert.equal(legacy.imageDelivery, undefined); assert.equal(legacy.image, undefined); assert.equal(legacy.text.startsWith('{"imageDelivery"'), false);
});

test('the image action retrieves one saved image through a closed selector and is an error when the delivery is not an attachment', async () => {
  const target = { source: 'reference', imageId: descriptor.imageId };
  const manager = fakeManager({}, { status: 'attached', image: descriptor, content: image });
  const result = await relayCall(manager, { action: 'image', guest: 'core-1', target });
  assert.equal(result.isError, false); assert.deepEqual(result.image, image);
  assert.deepEqual((manager as any).calls, [{ image: target }]);
  assert.match(result.text, /"executionFailed":false/);
  const stale = await relayCall(fakeManager({}, { status: 'stale-reference', diagnostic: 'closed' }), { action: 'image', guest: 'core-1', target: { source: 'display', sessionId: 's', executionId: 'e', phase: 'after' } });
  assert.equal(stale.isError, true); assert.equal(stale.image, undefined); assert.equal(stale.imageDelivery!.status, 'stale-reference');
  for (const bad of [{ action: 'image' }, { action: 'image', target: { source: 'reference', imageId: 'image-short' } }, { action: 'image', target: { source: 'display', sessionId: 's', executionId: 'e' } }, { action: 'image', target: { source: 'application', name: 'x', extra: true } }, { action: 'image', target, reason: 'rejected' }]) {
    await assert.rejects(relayCall(fakeManager({}), bad), /Invalid relay input/);
  }
});

test('console and capability actions dispatch with their fields, and console-open requires an explicit user request with reason and expected', async () => {
  const manager = fakeManager({});
  assert.deepEqual((await relayCall(manager, { action: 'acquisition-capabilities' })).details, { acquisitionCapabilities: true });
  assert.deepEqual((await relayCall(manager, { action: 'console-resolve', guest: 'core-1' })).details, { consoleResolve: true });
  const open = { action: 'console-open', guest: 'core-1', console_id: 'console-1', attempt_id: 'watch-1', userRequested: true, reason: 'The user asked to watch', expected: 'The viewer opens on the service host' };
  assert.deepEqual((await relayCall(manager, open)).details, { consoleOpen: true });
  assert.deepEqual((await relayCall(manager, { action: 'console-cancel', guest: 'core-1', console_id: 'console-1', attempt_id: 'watch-1' })).details, { consoleCancel: true });
  assert.deepEqual((await relayCall(manager, { action: 'probe', scope: 'guest', guest: 'core-1' })).details, { probed: true, scope: 'guest', guest: 'core-1' });
  const calls = (manager as any).calls;
  assert.deepEqual(calls[2].consoleOpen[0], open);
  assert.deepEqual(calls[3].consoleCancel[0], { action: 'console-cancel', guest: 'core-1', console_id: 'console-1', attempt_id: 'watch-1' });
  for (const bad of [{ ...open, userRequested: false }, { ...open, userRequested: undefined }, { ...open, expected: ' ' }, { ...open, reason: undefined }, { action: 'console-resolve', reason: 'rejected' }, { action: 'acquisition-capabilities', vnc: true }, { action: 'probe', scope: 'vm' }]) {
    await assert.rejects(relayCall(manager, bad), /Invalid relay input/);
  }
  await assert.rejects(relayCall(manager, { ...run, diagnostic: true, snapshots: { group: { groupId: 'g', phase: 'first' } } }), /Diagnostic scripts cannot join snapshot groups/);
});
