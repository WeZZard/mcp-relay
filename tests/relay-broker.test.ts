/**
 * Against the REAL broker: machine-service with MACHINE_SERVICE_GUEST_LINK=relay
 * and the real relay-agent, as vm-service's own end-to-end test runs them
 * (rust/crates/machine-service/tests/relay_e2e.rs). Fake `tart`, `ssh` and
 * `scp` stand for the VM host; the relay bootstrap's steps run for real
 * against a fake guest home, except the start step, and the test starts the
 * relay agent itself as an image that ships it would. The relay agent runs
 * commands on this machine, as this user, in temporary folders.
 *
 * Build both binaries from vm-service and point MCP_RELAY_TEST_BROKER_BIN_DIR at them:
 *
 *   cargo build -p machine-service -p relay-agent   # in vm-service/rust
 *   MCP_RELAY_TEST_BROKER_BIN_DIR=<vm-service>/rust/target/debug npm run test:broker
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { MachineService } from '../src/machine-service.js';
import { RelayManager } from '../src/manager.js';
import { Registry } from '../src/registry.js';
import { verifyDeliveredPackage } from '../src/package.js';
import { childEnvironment, childPath } from './isolation.js';

const binDir = process.env.MCP_RELAY_TEST_BROKER_BIN_DIR;
const daemonBin = binDir && join(binDir, 'machine-service');
const agentBin = binDir && join(binDir, 'relay-agent');
const skip = !binDir ? 'MCP_RELAY_TEST_BROKER_BIN_DIR is not set' : !existsSync(daemonBin!) || !existsSync(agentBin!) ? `machine-service or relay-agent is missing in ${binDir}` : false;
const bundle = fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Fake Tart: VMs are lines of a state file; `run` stays alive past the daemon's boot-settle window. */
const TART = `#!/bin/sh
set -u
root="\${TART_HOME:-\${FAKE_ROOT:-/tmp}}"
state="$root/fake-vms"
printf '%s\\n' "$*" >> "$root/tart-calls.log"
set_running() {
  tmp="$state.tmp"; : > "$tmp"
  if [ -f "$state" ]; then while IFS='=' read -r n r; do [ -n "$n" ] || continue; [ "$n" = "$1" ] && r="$2"; printf '%s=%s\\n' "$n" "$r" >> "$tmp"; done < "$state"; fi
  grep -q "^$1=" "$tmp" 2>/dev/null || printf '%s=%s\\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$state"
}
op="\${1:-}"; shift 2>/dev/null || true
case "$op" in
  list)
    printf 'Name\\tUUID\\tArch\\tDisk\\tState\\n'
    if [ -f "$state" ]; then while IFS='=' read -r n r; do [ -n "$n" ] || continue; if [ "$r" = "1" ]; then s=running; else s=stopped; fi; printf 'local  %s  100  11  aarch64  %s\\n' "$n" "$s"; done < "$state"; fi
    printf 'local  pilot-ubuntu-base  100  11  aarch64  stopped\\n' ;;
  clone) set_running "$2" 0 ;;
  stop) set_running "$1" 0 ;;
  delete)
    tmp="$state.tmp"; : > "$tmp"
    while IFS='=' read -r n r; do [ -n "$n" ] || continue; [ "$n" = "$1" ] && continue; printf '%s=%s\\n' "$n" "$r" >> "$tmp"; done < "$state"
    mv "$tmp" "$state" ;;
  ip) printf '198.51.100.99\\n' ;;
  run) set_running "$1" 1; sleep 12 ;;
  *) : ;;
esac
exit 0
`;
/** Fake SSH: the relay bootstrap's steps run in the fake guest home; the start step is answered without running; anything else is a plain stand-in. */
const SSH = `#!/bin/sh
set -u
root="\${FAKE_ROOT:-/tmp}"
printf '%s\\n' "$*" >> "$root/ssh-calls.log"
last=""; for a in "$@"; do last="$a"; done
case "$*" in
  *machine-service-relay-start*) cat > "$FAKE_GUEST_HOME/.relay-start-script"; echo "relay-start: state = running (the test's own relay agent)"; exit 0 ;;
  *machine-service-relay-*) HOME="$FAKE_GUEST_HOME" exec sh -c "$last" ;;
  *"test -s ~/.config/zsh/secrets.zsh"*) printf 'OK\\n'; exit 0 ;;
esac
if [ ! -t 0 ]; then input=$(cat 2>/dev/null || true); [ -n "$input" ] && { printf 'script-ran\\n'; exit 0; }; fi
[ "$last" = "true" ] && exit 0
printf 'ran: %s\\n' "$last"
`;
/** Fake scp: copies to and from a store keyed by the remote path. */
const SCP = `#!/bin/sh
set -u
store="\${FAKE_ROOT:-/tmp}/scp-store"; mkdir -p "$store"
src=""; dst=""; for a in "$@"; do src="$dst"; dst="$a"; done
case "$dst" in
  *:*) key=$(printf '%s' "\${dst#*:}" | tr '/' '_'); rm -rf "$store/$key"; cp -R "$src" "$store/$key" ;;
  *) key=$(printf '%s' "\${src#*:}" | tr '/' '_'); cp -R "$store/$key" "$dst" ;;
esac
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); server.on('error', reject); });
}
/** A stat record as machine-service's image association keeps it; inode and device stay exact as big integers. */
function statJson(path: string) {
  const s = statSync(path, { bigint: true });
  return `{"st_dev":${s.dev},"st_ino":${s.ino},"st_size":${s.size},"st_mtime_ns":${s.mtimeNs}}`;
}

/** The layout of vm-service's LegacyFixture: state, pilot-images tree with ubuntu2404, Tart store, credential pack and shims. */
async function lab(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-relay-broker-')));
  const state = join(root, 'state'), home = join(state, 'home'), pilot = join(state, 'pilot-images'), pilotState = join(state, 'pilot-state');
  const tartHome = join(home, '.tart'), bin = join(root, 'bin'), guestHome = join(root, 'guest');
  for (const dir of [home, join(pilot, 'images', 'ubuntu2404'), join(tartHome, 'vms'), bin, guestHome, join(home, '.config/vm-credentials/default')]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, '.config/vm-credentials/default/env.extra'), 'export MACHINE_SERVICE_TEST_ONLY=1\n');
  await writeFile(join(pilot, 'images/ubuntu2404/line.conf'), 'LINE_KIND=linux\nBASE_VM=pilot-ubuntu-base\nCLONE_PREFIX=pilot-\nGUEST_USER=admin\nGUEST_PASS=admin\nWORK_VM=pilot-ubuntu-work\n');
  for (const name of ['pilot-ubuntu-base', 'pilot-ubuntu-work']) {
    await mkdir(join(tartHome, 'vms', name), { recursive: true });
    await writeFile(join(tartHome, 'vms', name, 'config.json'), 'fixture'); await writeFile(join(tartHome, 'vms', name, 'disk.img'), 'fixture');
  }
  await writeFile(join(tartHome, 'fake-vms'), 'pilot-ubuntu-work=0\n');
  const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, image: 'ubuntu2404', inventory: { schemaVersion: 1, os: 'linux', architecture: 'arm64', collectedAt: '2026-09-16T00:00:00Z', sources: [{ id: 'dpkg', status: 'available' }], applications: [{ id: 'fixture', name: 'Fixture App', aliases: [], version: null }] }, provenance: { extractionMode: 'work', evidenceId: 'fixture', rawSha256: '0'.repeat(64), collectorSha256: '1'.repeat(64), aliasesSha256: '2'.repeat(64) } }));
  await writeFile(join(pilot, 'images/ubuntu2404/applications.json'), raw);
  const base = await realpath(join(tartHome, 'vms/pilot-ubuntu-base'));
  const association = `{"schemaVersion":2,"image":"ubuntu2404","base":{"base_vm":"pilot-ubuntu-base","path":${JSON.stringify(base)},"files":{"config.json":${statJson(join(base, 'config.json'))},"disk.img":${statJson(join(base, 'disk.img'))}}},"inventorySha256":"${sha(raw)}"}`;
  const namespace = sha(await realpath(join(tartHome, 'vms')));
  await mkdir(join(pilotState, 'stores', namespace, 'base'), { recursive: true });
  await writeFile(join(pilotState, 'stores', namespace, 'base/ubuntu2404.json'), association);
  for (const [name, text] of [['tart', TART], ['ssh', SSH], ['scp', SCP]] as const) { await writeFile(join(bin, name), text); await chmod(join(bin, name), 0o755); }

  const port = await freePort(), sessionPort = await freePort();
  const relayUrl = `wss://localhost:${sessionPort}/relay`;
  const env = childEnvironment({
    PATH: childPath(bin), HOME: home, MACHINE_SERVICE_STATE: state, MACHINE_SERVICE_PORT: String(port), PILOT_REPO: pilot, PILOT_IMAGES_STATE_DIR: pilotState, TART_HOME: tartHome, FAKE_ROOT: tartHome, FAKE_GUEST_HOME: guestHome,
    MACHINE_SERVICE_GUEST_LINK: 'relay', MACHINE_SERVICE_SESSION_PORT: String(sessionPort), MACHINE_SERVICE_RELAY_GUEST_URL: relayUrl, MACHINE_SERVICE_RELAY_URL: relayUrl,
    MACHINE_SERVICE_RELAY_REGISTER_TIMEOUT: '30', MACHINE_SERVICE_RELAY_AGENT_WAIT: '30', MACHINE_SERVICE_RELAY_AGENT: agentBin!,
  });
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const startDaemon = async () => {
    const child = spawn(daemonBin!, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; child.stderr!.on('data', data => { log += data; }); logs.push(''); const at = logs.length - 1; child.stderr!.on('data', () => { logs[at] = log; });
    children.push(child);
    const deadline = Date.now() + 30000;
    for (;;) {
      try { const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as Record<string, unknown>; if (health.ok) return child; } catch { /* not up yet */ }
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`machine-service did not start:\n${log}`);
      await sleep(100);
    }
  };
  const stopDaemon = async (child: ChildProcess) => { if (child.exitCode !== null) return; const exited = new Promise(done => child.on('exit', done)); child.kill('SIGTERM'); await Promise.race([exited, sleep(10000)]); if (child.exitCode === null) child.kill('SIGKILL'); };
  // The guest's relay agent, in the guest's "desktop session": it waits for the configuration the bootstrap writes.
  const agentLog = join(root, 'agent.log');
  const agent = spawn(agentBin!, ['run'], { env: childEnvironment({ HOME: guestHome, SHELL: '/bin/sh' }), stdio: ['ignore', 'ignore', 'pipe'] });
  let agentText = ''; agent.stderr!.on('data', data => { agentText += data; });
  children.push(agent);
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); }
    await rm(root, { recursive: true, force: true });
  });
  return { root, guestHome, port, startDaemon, stopDaemon, agentLog: () => agentText, daemonLog: () => logs.join('\n---\n'), relayCalls: () => readFile(join(tartHome, 'ssh-calls.log'), 'utf8').catch(() => '') };
}

/** Counts machine-service's HTTP guest operations, which a relay lease must not use. */
function countHttpOperations(t: TestContext) {
  const original = globalThis.fetch, seen: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (/\/(exec|push|pull|files)$/.test(path)) seen.push(path);
    return original(input, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return seen;
}

test('guest operations of a relay lease go through the real broker and relay agent, with execution IDs, and recover across a broker restart', { skip, timeout: 240000 }, async t => {
  const l = await lab(t);
  let daemon = await l.startDaemon();
  const http = countHttpOperations(t);
  const linkLog: string[] = [];
  const vm = new MachineService({ baseUrl: `http://127.0.0.1:${l.port}`, timeoutMs: 120000, relay: { log: line => linkLog.push(line) } });
  const health = await vm.health() as Record<string, unknown>;
  assert.match(String(health.relay_url), /^wss:\/\/localhost:\d+\/relay$/);
  assert.match(String(health.relay_ca_sha256), /^[0-9a-f]{64}$/);

  const lease = await vm.acquire({ purpose: `relay-m6b-${randomUUID().slice(0, 8)}`, image: 'ubuntu2404', env: 'none' });
  assert.equal(lease.link, 'relay', `${JSON.stringify(lease)}\nagent:\n${l.agentLog()}\ndaemon:\n${l.daemonLog()}`);
  assert.ok(lease.relay?.credential && lease.relay.ca_pem);
  assert.equal(await vm.relayLink(lease.vm), true);

  // exec: the relay's execution ID makes a repeat a replay, never a second run (RP-7).
  const argv = ['sh', '-c', 'echo run >> runs; pwd; wc -l < runs | tr -d " "'];
  const ran = await vm.exec(lease.vm, { argv, execution_id: 'ts-once' });
  assert.deepEqual(ran, { vm: lease.vm, rc: 0, output: `${l.guestHome}\n1\n`, link: 'relay', execution_id: 'ts-once' });
  assert.equal((await vm.exec(lease.vm, { argv, execution_id: 'ts-once' })).output, ran.output);
  assert.equal(await readFile(join(l.guestHome, 'runs'), 'utf8'), 'run\n', 'never runs twice');
  // Arguments mean the same as over SSH: machine-service's quoting.
  assert.equal((await vm.exec(lease.vm, { argv: ['printf', '%s|', "it's", 'a b', ''] })).output, "it's|a b||");
  const script = await vm.exec(lease.vm, { script: 'echo from-script; exit 3' });
  assert.equal(script.rc, 3); assert.equal(script.output, 'from-script\n');

  // Files over 1 MiB cross the 1 MiB message cap only in chunks (TC-8).
  const bytes = Buffer.from(Array.from({ length: 3 * 1024 * 1024 + 5 }, (_, i) => i % 251));
  const local = join(l.root, 'push.bin'); await writeFile(local, bytes);
  await vm.push(lease.vm, { local_path: local, remote_path: 'pushed.bin' });
  assert.ok((await readFile(join(l.guestHome, 'pushed.bin'))).equals(bytes));
  const back = join(l.root, 'pulled.bin');
  await vm.pull(lease.vm, { remote_path: 'pushed.bin', local_path: back });
  assert.ok((await readFile(back)).equals(bytes));
  assert.deepEqual(await vm.pushBytes(lease.vm, { remote_path: 'bytes.bin', bytes: Buffer.from('as bytes') }), { sha256: sha('as bytes'), bytes: 8 });
  const bytesBack = join(l.root, 'bytes-back.bin');
  assert.deepEqual(await vm.pullBytes(lease.vm, { remote_path: 'bytes.bin', to: bytesBack }), { sha256: sha('as bytes'), bytes: 8 });
  await assert.rejects(vm.pull(lease.vm, { remote_path: 'missing.bin', local_path: join(l.root, 'missing.bin') }), /not_found/);

  // A broker restart while a command runs: the session cannot resume, so the
  // client opens a new one, queries the execution, and takes its recorded
  // answer from the relay agent; the command ran once.
  const slow = vm.exec(lease.vm, { argv: ['sh', '-c', 'sleep 4; echo slept >> slept.log; cat slept.log'], execution_id: 'ts-restart' });
  await sleep(1000);
  await l.stopDaemon(daemon);
  daemon = await l.startDaemon();
  const recovered = await slow;
  assert.equal(recovered.output, 'slept\n', l.daemonLog());
  assert.equal(await readFile(join(l.guestHome, 'slept.log'), 'utf8'), 'slept\n');
  assert.ok(linkLog.some(line => /session expired \(unknown\)/.test(line)), `the restarted broker did not know the session:\n${linkLog.join('\n')}`);
  assert.equal((await vm.exec(lease.vm, { argv: ['cat', 'runs'], execution_id: 'ts-once' })).output, ran.output, 'the record outlives the broker restart');

  assert.deepEqual(http, [], 'no guest operation went over machine-service\'s HTTP API');
  const released = await vm.release(lease.vm);
  assert.equal(released.released, true);
  void daemon;
});

test('a relay run stages, runs and finishes through the broker, and its evidence package verifies', { skip, timeout: 240000 }, async t => {
  const l = await lab(t);
  await l.startDaemon();
  const http = countHttpOperations(t);
  const vm = new MachineService({ baseUrl: `http://127.0.0.1:${l.port}`, timeoutMs: 120000 });
  const registryPath = join(l.root, 'AGENTS.md');
  await writeFile(registryPath, '# Test registry\n\n## Using VMs\n\n| Machine | OS | Task Name | Agent | Project | Start Date |\n| -- | -- | -- | -- | -- | -- |\n\n## End\n');
  const project = join(l.root, 'project'); await mkdir(project);
  const manager = new RelayManager({ project, sessionId: randomUUID(), stateRoot: join(l.root, 'relay-state'), tartHome: join(l.root, 'tart'), tartPath: join(l.root, 'no-tart'), outputRoot: join(l.root, 'packages'), registry: new Registry(registryPath), vm, runtimeBundle: bundle, heartbeatMs: 60000, verifyDestroyed: async () => true });
  let guestRoot: string | undefined;
  t.after(async () => { await manager.release().catch(() => {}); await manager.cleanup('test teardown').catch(() => {}); if (guestRoot) await rm(guestRoot, { recursive: true, force: true }); });

  const acquired = await manager.acquire({ image: 'ubuntu2404', task: 'relay-broker', extractions: [] }) as { guest: string; guestRoot: string; link?: string };
  guestRoot = acquired.guestRoot;
  assert.equal(manager.guestStatus().link, 'relay', 'the guest status reports the link');
  await manager.stage({ cuaDriver: join(l.root, 'no-cua-driver'), nodePath: process.execPath });
  const run = await manager.run({ because: 'Exercise the relay agent link end to end', language: 'shell', inline: true, code: `'${process.execPath}' -e 'require("fs").writeFileSync("artifact.txt","through the broker");console.log("ran through the broker")'`, step: { id: 'broker', title: 'broker', expected: 'The command runs in the relay agent', inputMode: 'ordinary' }, snapshots: { afterIntervalMs: 0 } });
  assert.equal(run.outcome.kind, 'completed', JSON.stringify(run));
  const delivered = await manager.finish();
  assert.equal(delivered.deliveryVerified, true, JSON.stringify(delivered));
  assert.equal(delivered.execution, 'passed');
  // The package verifies again from disk, as a reviewer's verification would.
  const verified = await verifyDeliveredPackage(dirname(delivered.manifestPath));
  assert.equal(verified.deliveryVerified, true);
  assert.deepEqual(http, [], 'staging, the run and the evidence download all went through the broker');
});
