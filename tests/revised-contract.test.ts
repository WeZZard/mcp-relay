import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRelayInput } from '../src/schema.js';
import { probeLocal } from '../src/probe.js';

const run = { action: 'run', kind: 'exec', guest: 'check-1', reason: 'Inspect the owned guest', argv: ['true'], step: { id: 'check', title: 'Check', expected: 'Exit zero', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } };

test('execution timeout is bounded independently from screenshot timing and TTL', () => {
  for (const timeoutMs of [1, 120000, 3600000]) assert.doesNotThrow(() => validateRelayInput({ ...run, timeoutMs }));
  for (const timeoutMs of [0, -1, 1.5, 3600001, NaN, Infinity, '1000']) assert.throws(() => validateRelayInput({ ...run, timeoutMs }));
  assert.throws(() => validateRelayInput({ action: 'probe', timeoutMs: 1000 }));
  assert.doesNotThrow(() => validateRelayInput(run));
});

test('diagnostic execution is explicit, relay_command-only, and cannot join a screenshot group', () => {
  assert.doesNotThrow(() => validateRelayInput({ ...run, diagnostic: true }));
  assert.throws(() => validateRelayInput({ ...run, argv: undefined, diagnostic: true, kind: 'script', inline: true, code: '1', language: 'javascript' }), /Invalid relay input/, 'relay_script takes no diagnostic (DC-23)');
  assert.throws(() => validateRelayInput({ ...run, argv: undefined, diagnostic: true, kind: 'code', code: '1', language: 'javascript' }), /Invalid relay input/, 'relay_code is gone (DC-23)');
  assert.throws(() => validateRelayInput({ ...run, diagnostic: true, snapshots: { group: { groupId: 'g', phase: 'first' } } }));
  assert.throws(() => validateRelayInput({ action: 'stage', diagnostic: true }));
});

test('probe differentiates host facts from guest checks without a new tool or action', () => {
  for (const scope of ['host', 'guest']) assert.doesNotThrow(() => validateRelayInput({ action: 'probe', scope, guest: 'check-1' }));
  assert.doesNotThrow(() => validateRelayInput({ action: 'probe', scope: 'host' }));
  assert.throws(() => validateRelayInput({ action: 'probe', scope: 'guest' }), /names the guest to probe/, 'a guest probe names its guest (DC-20)');
  assert.throws(() => validateRelayInput({ ...run, guest: undefined }), /Invalid relay input/, 'a run names its guest (DC-20)');
  assert.throws(() => validateRelayInput({ ...run, guest: '../escape' }), /Invalid relay input/);
  assert.throws(() => validateRelayInput({ action: 'probe', scope: 'any' }));
});

test('macOS idle query is scoped and retains the established nanosecond formula', async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { code: 0, stderr: '', stdout: argv[0].includes('ioreg') ? '"HIDIdleTime" = 2500000000' : argv[0].includes('stat') ? 'someone' : '{}' };
  };
  const facts = await probeLocal(run, 'darwin');
  assert.ok(calls.some(a => JSON.stringify(a) === JSON.stringify(['/usr/sbin/ioreg', '-r', '-c', 'IOHIDSystem'])));
  assert.equal(facts.idleSeconds.value, 2.5);
  assert.match(facts.idleSeconds.formula, /nanoseconds \/ 1e9/);
  const unknown = await probeLocal(async () => ({ code: 1, stderr: 'unavailable', stdout: '' }), 'darwin');
  assert.equal(unknown.idleSeconds.value, null);
  assert.equal(unknown.screenshot.available, null);
});
