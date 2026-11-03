import assert from 'node:assert/strict';
import test from 'node:test';
import { MachineService, type Transport } from '../src/machine-service.js';

/** The client's own transport, injected: no test replaces the platform's fetch, and the origin is one nothing listens on (DC-6x-ISO-2). */
const ORIGIN = 'http://127.0.0.1:9';

test('console HTTP contract sends only IDs, uses read-only capability GET and never retries', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const transport: Transport = async (url, init) => {
    requests.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ status: 'ready' }));
  };
  const client = new MachineService({ baseUrl: ORIGIN, transport });
  const body = { lease_id: 'lease-1', console_id: 'console-1', attempt_id: 'watch-1' };
  await client.acquisitionCapabilities();
  await client.consoleResolve('vm-1', { lease_id: body.lease_id });
  await client.consoleOpen('vm-1', body);
  await client.consoleCancel('vm-1', body);
  assert.deepEqual(requests, [
    { url: `${ORIGIN}/acquisition-capabilities`, method: 'GET', body: undefined },
    { url: `${ORIGIN}/machines/vm-1/console/resolve`, method: 'POST', body: { lease_id: 'lease-1' } },
    { url: `${ORIGIN}/machines/vm-1/console/open`, method: 'POST', body },
    { url: `${ORIGIN}/machines/vm-1/console/cancel`, method: 'POST', body },
  ]);
});

test('selected environment fingerprint accompanies all console requests', async () => {
  const fingerprints: string[] = [];
  const transport: Transport = async (_url, init) => {
    fingerprints.push((init.headers as Record<string, string>)['X-VM-Environment-Fingerprint']);
    return new Response('{}');
  };
  const client = new MachineService({ environment: { profile: { vmServiceUrl: 'http://127.0.0.1:6249' }, identity: { fingerprint: 'selected-fingerprint' } } as any, transport });
  await client.acquisitionCapabilities();
  await client.consoleResolve('vm-1', { lease_id: 'lease-1' });
  await client.consoleOpen('vm-1', { lease_id: 'lease-1', console_id: 'console-1', attempt_id: 'watch-1' });
  await client.consoleCancel('vm-1', { lease_id: 'lease-1', console_id: 'console-1', attempt_id: 'watch-1' });
  assert.deepEqual(fingerprints, Array(4).fill('selected-fingerprint'));
});

test('console API errors never return upstream credentials or endpoints', async () => {
  let calls = 0;
  const transport: Transport = async () => { calls++; return new Response('vnc://SECRET@localhost:5900', { status: 404 }); };
  await assert.rejects(new MachineService({ baseUrl: ORIGIN, transport }).acquisitionCapabilities(), error => {
    assert.match(String(error), /HTTP 404/); assert.doesNotMatch(JSON.stringify(error) + String(error), /SECRET|5900/); return true;
  });
  assert.equal(calls, 1);
});
