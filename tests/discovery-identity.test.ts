import assert from 'node:assert/strict';
import test from 'node:test';
import * as discovery from '../src/discovery.js';
import { findDurableOwner, parseRegistrations } from '../src/discovery.js';
import type { VmBackend } from '../src/machine-service.js';
import { assemble, parseRecords, type Advertised } from '../src/mdns.js';

const ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const origin = 'http://192.0.2.4:6240';
const record = (name: string, machine_id?: string) => ({ kind: 'durable', name, instance: name, state: 'available', ...(machine_id ? { machine_id } : {}) });
function backend(baseUrl: string, instance: string, machines: Record<string, unknown> = {}, machine_id?: string): VmBackend {
  return { baseUrl, health: async () => ({ ok: true, service: 'machine-service', instance, ...(machine_id ? { machine_id } : {}) }), list: async () => ({ machines, limits: { max_macos_running: 2, grace_hours: 6 }, pilot_repo: '', port: Number(new URL(baseUrl).port) }) } as unknown as VmBackend;
}
const local = () => backend('http://localhost:6240', 'Mac-A');
const advertised = (instance: string, machine_id?: string): Advertised => ({ name: instance, instance, host: `${instance}.local`, address: '192.0.2.4', port: 6240, txt: { txtvers: '1', instance, ...(machine_id ? { machine_id } : {}) } });

test('Consul registrations carry machine_id without requiring an instance name (DC-37)', () => {
  assert.deepEqual(parseRegistrations([{ Node: { Node: 'node-a' }, Service: { Address: '192.0.2.4', Port: 6240, Meta: { machine_id: ID } } }]), [
    { node: 'node-a', origin, machine_id: ID, loopbackOnly: false },
  ]);
});

const dnsName = (name: string) => Buffer.concat([...name.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]), Buffer.from([0])]);
function dnsResponse(records: Array<{ name: string; type: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records.map(r => {
    const fixed = Buffer.alloc(10); fixed.writeUInt16BE(r.type, 0); fixed.writeUInt16BE(1, 2); fixed.writeUInt32BE(120, 4); fixed.writeUInt16BE(r.data.length, 8);
    return Buffer.concat([dnsName(r.name), fixed, r.data]);
  })]);
}

test('Bonjour TXT machine_id is carried alongside txtvers=1 (DC-37)', () => {
  const service = '_machine-service._tcp.local', full = `Mac-A.${service}`;
  const srv = Buffer.alloc(6); srv.writeUInt16BE(6240, 4);
  const txt = Buffer.concat(['txtvers=1', 'instance=Mac-A', `machine_id=${ID}`].map(pair => Buffer.concat([Buffer.from([pair.length]), Buffer.from(pair)])));
  const [found] = assemble(service, parseRecords(dnsResponse([
    { name: service, type: 12, data: dnsName(full) },
    { name: full, type: 33, data: Buffer.concat([srv, dnsName('Mac-A.local')]) },
    { name: full, type: 16, data: txt },
  ])));
  assert.equal(found?.machine_id, ID);
  assert.equal(found?.txt.txtvers, '1');
});

test('name discovery saves the owner machine_id from health or the durable record (DC-37)', async () => {
  for (const source of ['health', 'record'] as const) {
    const remote = backend(origin, 'Mac-A', { 'Mac-A': record('Mac-A', source === 'record' ? ID : undefined) }, source === 'health' ? ID : undefined);
    const owner = await findDurableOwner('Mac-A', { local: local(), mode: 'bonjour', browse: async () => [advertised('Mac-A')], backend: () => remote });
    assert.equal(owner.machine_id, ID, source);
  }
});

test('Bonjour confirms machine_id across a stale instance name and refuses a different ID (DC-37)', async () => {
  let healthId = ID;
  const options = { local: local(), mode: 'bonjour' as const, browse: async () => [advertised('Mac-A', ID)], backend: () => backend(origin, 'Mac-B', { 'Mac-B': record('Mac-B', healthId) }, healthId) };
  const owner = await findDurableOwner('Mac-B', options);
  assert.equal(owner.instance, 'Mac-B');
  assert.equal(owner.machine_id, ID);
  healthId = OTHER_ID;
  await assert.rejects(findDurableOwner('Mac-B', options), /unconfirmed:.*machine_id/);
});

test('Consul confirms its machine_id with health and takes the current instance name (DC-37)', async () => {
  let healthId = ID;
  const options = { local: local(), mode: 'consul' as const, fetchJson: async () => [{ Node: { Node: 'node-a' }, Service: { Address: '192.0.2.4', Port: 6240, Meta: { instance: 'Mac-A', machine_id: ID } } }], backend: () => backend(origin, 'Mac-B', { 'Mac-B': record('Mac-B', healthId) }, healthId) };
  const owner = await findDurableOwner('Mac-B', options);
  assert.equal(owner.instance, 'Mac-B');
  assert.equal(owner.machine_id, ID);
  healthId = OTHER_ID;
  await assert.rejects(findDurableOwner('Mac-B', options), /unconfirmed:.*machine_id/);
});

test('owner lookup by machine_id finds a renamed Bonjour or Consul candidate (DC-37)', async () => {
  for (const mode of ['bonjour', 'consul'] as const) {
    const remote = backend(origin, 'Mac-B', { 'Mac-B': record('Mac-B', ID) }, ID);
    const owner = await discovery.findDurableOwnerById(ID, {
      local: local(), mode, browse: async () => [advertised('Mac-A', ID)],
      fetchJson: async () => [{ Node: { Node: 'node-a' }, Service: { Address: '192.0.2.4', Port: 6240, Meta: { machine_id: ID } } }],
      backend: () => remote,
    });
    assert.equal(owner.backend, remote);
    assert.equal(owner.instance, 'Mac-B');
    assert.equal(owner.machine_id, ID);
  }
});

test('discovery distinguishes machine IDs and ports while deduplicating one owner address (DC-37)', async () => {
  const options = { mode: 'bonjour' as const, browse: async () => [advertised('Mac-A', ID)] };
  const self = backend('http://localhost:6240', 'Mac-B', { 'Mac-A': record('Mac-B', ID) }, ID);
  const remote = backend(origin, 'Mac-A', { 'Mac-A': record('Mac-A', ID) }, ID);
  assert.equal((await findDurableOwner('Mac-A', { ...options, local: self, backend: () => remote })).origin, self.baseUrl, 'the same identity and port is counted once despite name or address changes');
  const otherPort = { ...advertised('Mac-A', ID), port: 6241 };
  await assert.rejects(discovery.findDurableOwnerById(ID, { ...options, local: self, browse: async () => [otherPort], backend: candidate => backend(candidate, 'Mac-A', { 'Mac-A': record('Mac-A', ID) }, ID) }), /more than one instance/);
  await assert.rejects(findDurableOwner('Mac-A', { ...options, local: backend('http://localhost:6240', 'Mac-A', { 'Mac-A': record('Mac-A', OTHER_ID) }, OTHER_ID), backend: () => remote }), /more than one instance/);
});

test('discovery refuses a durable record whose machine_id contradicts health (DC-37)', async () => {
  const remote = backend(origin, 'Mac-A', { 'Mac-A': record('Mac-A', OTHER_ID) }, ID);
  await assert.rejects(findDurableOwner('Mac-A', { local: local(), mode: 'bonjour', browse: async () => [advertised('Mac-A', ID)], backend: () => remote }), /unconfirmed:.*machine_id/);
});

test('legacy discovery without machine_id keeps the record instance and name confirmation (DC-37)', async () => {
  const self = backend('http://localhost:6240', 'Mac-B', { 'Mac-A': record('Mac-A') });
  assert.equal((await findDurableOwner('Mac-A', { local: self, mode: 'bonjour', browse: async () => [] })).instance, 'Mac-A');
  await assert.rejects(findDurableOwner('Mac-A', { local: local(), mode: 'bonjour', browse: async () => [advertised('Mac-A')], backend: () => backend(origin, 'Mac-B', { 'Mac-A': record('Mac-A') }) }), /it was found as Mac-A, but its \/health answers Mac-B/);
});

test('name discovery refuses an explicit wrong service on local and unlabelled Consul candidates (DC-37)', async () => {
  const wrongService = (baseUrl: string) => ({ ...backend(baseUrl, 'Mac-A', { 'Mac-A': record('Mac-A', ID) }, ID), health: async () => ({ ok: true, service: 'other-service', instance: 'Mac-A', machine_id: ID }) });
  await assert.rejects(findDurableOwner('Mac-A', { local: wrongService('http://localhost:6240'), mode: 'bonjour', browse: async () => [] }), /unconfirmed:.*answers as other-service/);
  await assert.rejects(findDurableOwner('Mac-A', { local: local(), mode: 'consul', fetchJson: async () => [{ Node: { Node: 'node-a' }, Service: { Address: '192.0.2.4', Port: 6240 } }], backend: () => wrongService(origin) }), /unconfirmed:.*answers as other-service/);
});

test('looking up by machine_id confirms an unlabelled candidate by its own name, never by the target ID (DC-37)', async () => {
  const legacy = { ...advertised('Mac-L'), address: '192.0.2.7' };
  const target = { ...advertised('Mac-B', ID), address: '192.0.2.4' };
  const backends: Record<string, VmBackend> = {
    'http://192.0.2.7:6240': backend('http://192.0.2.7:6240', 'Mac-L', { 'Mac-L': record('Mac-L') }),
    [origin]: backend(origin, 'Mac-B', { 'Mac-B': record('Mac-B', ID) }, ID),
  };
  const owner = await discovery.findDurableOwnerById(ID, { local: local(), mode: 'bonjour', browse: async () => [legacy, target], backend: o => backends[o]! });
  assert.equal(owner.origin, origin);
  const missing = await discovery.findDurableOwnerById(OTHER_ID, { local: local(), mode: 'bonjour', browse: async () => [legacy], backend: o => backends[o]!, secondLookMs: 0 }).catch((error: Error) => error.message);
  assert.doesNotMatch(String(missing), /found with machine_id/, 'an instance that advertised no machine_id is not reported as contradicting one');
});

test('Bonjour looks a second time before reporting a durable machine missing (MI-5, DC-37)', async () => {
  for (const find of [(o: discovery.DiscoveryOptions) => findDurableOwner('Mac-B', o), (o: discovery.DiscoveryOptions) => discovery.findDurableOwnerById(ID, o)]) {
    let browses = 0;
    const remote = backend(origin, 'Mac-B', { 'Mac-B': record('Mac-B', ID) }, ID);
    const owner = await find({ local: local(), mode: 'bonjour', secondLookMs: 0, browse: async () => (++browses === 1 ? [] : [advertised('Mac-B', ID)]), backend: () => remote });
    assert.equal(owner.backend, remote, 'the second browse finds the owner the first one missed');
    assert.equal(browses, 2);
  }
  let consulAsks = 0;
  await assert.rejects(findDurableOwner('Mac-B', { local: local(), mode: 'consul', secondLookMs: 0, fetchJson: async () => { consulAsks++; return []; } }), /No machine-service instance/);
  assert.equal(consulAsks, 1, 'Consul answers from its catalog, so it is asked once');
});

