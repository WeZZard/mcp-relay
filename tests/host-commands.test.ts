import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { allToolDefinitions } from '../src/server.js';
// @ts-expect-error: a plain .mjs module shared with the build, without type declarations.
import { COMMAND_DIRS, COMMANDS, hostCommandFiles } from '../scripts/host-commands.mjs';

test('the committed host command files are exactly what the build generates', async () => {
  const expected: Record<string, string> = hostCommandFiles();
  for (const [path, content] of Object.entries(expected)) assert.equal(await readFile(path, 'utf8'), content, `${path} is stale: run npm run build`);
  const present = (await Promise.all(Object.values(COMMAND_DIRS).map(async dir => (await readdir(dir as string)).map(name => `${dir}/${name}`)))).flat();
  assert.deepEqual(present.sort(), Object.keys(expected).sort(), 'no extra files in the generated directories');
});

test('each host names the commands the same way: /mcp-relay-<name> in pi, /mcp-relay:<name> in Claude Code', () => {
  assert.deepEqual(Object.keys(hostCommandFiles()).sort(), [
    'commands/status.md',
    'pi-prompts/mcp-relay-status.md',
  ]);
});

test('every command asks for a tool the server offers', () => {
  const tools = new Set(allToolDefinitions().map(tool => tool.name));
  for (const command of COMMANDS) {
    assert.ok(tools.has(command.tool), command.tool);
    assert.ok(command.body.includes(`\`${command.tool}\``), `${command.name} names ${command.tool}`);
  }
});
