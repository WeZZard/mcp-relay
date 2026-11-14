/**
 * The broker route (config.ts `brokerRoute`): the relay reaches a broker
 * behind an edge that ordinary DNS and the public roots do not reach, such as
 * the relay acceptance's network rig, the way curl's --resolve and --cacert
 * do, and nothing changes when the route is unset.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { brokerRoute } from '../src/config.js';
import { webSocketDial } from '../src/relay-client.js';
import { childEnvironment } from './isolation.js';

const NAME = 'broker.relay-rig.test';

/** A throwaway authority and a server certificate for `NAME` that it signs. */
function edgeCertificates(dir: string) {
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore', env: childEnvironment() });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=rig-edge-ca', '-days', '1', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem')]);
  run(['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', `/CN=${NAME}`, '-keyout', join(dir, 'edge.key'), '-out', join(dir, 'edge.csr')]);
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:${NAME}\n`);
  run(['x509', '-req', '-in', join(dir, 'edge.csr'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-sha256', '-days', '1', '-extfile', join(dir, 'ext.cnf'), '-out', join(dir, 'edge.pem')]);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=instance-ca', '-days', '1', '-keyout', join(dir, 'other.key'), '-out', join(dir, 'other.pem')]);
  return { ca: join(dir, 'ca.pem'), key: readFileSync(join(dir, 'edge.key')), cert: readFileSync(join(dir, 'edge.pem')), instanceCa: readFileSync(join(dir, 'other.pem'), 'utf8') };
}

test('the broker route parses its two settings and refuses malformed ones', t => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(brokerRoute({}), {});
  assert.deepEqual(brokerRoute({ MCP_RELAY_BROKER_RESOLVE: 'Broker.Relay-Rig.test=127.0.0.1' }), { resolve: { host: NAME, address: '127.0.0.1' } });
  for (const bad of ['broker.relay-rig.test', '=127.0.0.1', 'broker.relay-rig.test=not-an-address', 'bad host=127.0.0.1']) {
    assert.throws(() => brokerRoute({ MCP_RELAY_BROKER_RESOLVE: bad }), /MCP_RELAY_BROKER_RESOLVE/, bad);
  }
  writeFileSync(join(dir, 'not.pem'), 'hello');
  assert.throws(() => brokerRoute({ MCP_RELAY_BROKER_CA: join(dir, 'not.pem') }), /PEM certificate/);
  assert.throws(() => brokerRoute({ MCP_RELAY_BROKER_CA: 'relative.pem' }), /MCP_RELAY_BROKER_CA/);
});

test('with the route, the relay dials a broker name that DNS does not know, behind an edge whose authority it was given; without it, it cannot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-route-'));
  const { ca, key, cert, instanceCa } = edgeCertificates(dir);
  const server = createServer({ key, cert });
  const wss = new WebSocketServer({ server, path: '/relay' });
  wss.on('connection', socket => socket.on('message', data => socket.send(data)));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { wss.close(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const url = `wss://${NAME}:${port}/relay`;

  const route = brokerRoute({ MCP_RELAY_BROKER_RESOLVE: `${NAME}=127.0.0.1`, MCP_RELAY_BROKER_CA: ca });
  let echoed = '';
  const link = await webSocketDial(url, instanceCa, 5000, route)({ message: data => { echoed = String(data); }, closed: () => {} });
  link.send('hello');
  for (let i = 0; i < 100 && !echoed; i++) await new Promise(done => setTimeout(done, 20));
  assert.equal(echoed, 'hello');
  link.close();

  await assert.rejects(webSocketDial(url, instanceCa, 5000, {})({ message: () => {}, closed: () => {} }), 'no route: the name does not resolve');
  await assert.rejects(webSocketDial(url, instanceCa, 5000, { resolve: route.resolve! })({ message: () => {}, closed: () => {} }), /certificate|self.signed|unable to verify/i, 'no edge authority: the certificate is refused');
});
