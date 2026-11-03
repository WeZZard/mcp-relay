// The machine-service instance a live tool drives: a second instance that
// machine-service's launcher started, never the installed one (DC-66, DC-71).
//
// machine-service's conventions (its DC-243 to DC-246, crate
// `second-instance`): `second-instance start --root DIR --port N
// --session-port N --tart-home DIR` starts one under a root it owns and
// writes `<root>/second-instance.json` before anything else; the daemon then
// reports `second_instance: {id}` in `/health`, and a live client runs only
// against an instance that does, never on port 6240 or 6241, with no
// override. Tart clones only within its own store, so an instance may be
// given the operator's store (~/.tart) to read its bases (DC-246): it then
// creates and deletes only clones named `si-<id>-…`, with Tart's auto-prune
// off. A live tool accepts that store only from such an instance, and
// refuses any operation on a VM outside the prefix.
//
// Plain JavaScript, so that `scripts/live-check.mjs` runs it under node and
// the TypeScript scripts import it through `second-instance.d.mts`.
import { lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The launcher's manifest under an instance's root. */
export const MANIFEST = 'second-instance.json';
/** The installed instance's HTTP and broker ports, which no second instance has. */
export const INSTALLED_PORTS = [6240, 6241];
/** A second instance's ID: 1 to 16 lower-case letters and digits (the crate's `valid_id`). */
const ID = /^[a-z0-9]{1,16}$/;
/** The prefix of every clone the instance `id` makes (the crate's `vm_prefix`). */
export const vmPrefix = id => `si-${id}-`;

/** An absolute path with every existing ancestor's links resolved (the crate's `canonical`). */
export function canonicalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${String(path)} is not an absolute path`);
  let ancestor = resolve(path);
  const suffix = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`${ancestor} is a dangling link`); }
      catch (entry) { if (entry.code !== 'ENOENT') throw entry; }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor)); ancestor = parent;
    }
  }
}

const within = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
/** Whether one folder lies in the other, or they are the same (the crate's `overlaps`). */
export const overlaps = (a, b) => { const [x, y] = [canonicalPath(a), canonicalPath(b)]; return within(x, y) || within(y, x); };

/**
 * The second instance the launcher's manifest at `root` describes, refused
 * when it shares anything with the installed instance of the operator whose
 * home is `home`: the installed ports, a bind address off loopback (a
 * lifecycle runs beside its instance), or a daemon environment that does
 * not carry the manifest's ID, its Tart store and Tart's auto-prune off. Its
 * store is its own or exactly the operator's, never a folder inside or
 * around the operator's.
 */
export function secondInstance(manifest, root, home) {
  const at = join(root, MANIFEST);
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error(`${at} names no second-instance id`);
  if (typeof m.root !== 'string' || !isAbsolute(m.root) || canonicalPath(m.root) !== canonicalPath(root)) throw new Error(`${at} is the manifest of another root (${String(m.root)})`);
  for (const key of ['port', 'session_port']) {
    const port = m[key];
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`${at}: ${key} is not a port`);
    if (INSTALLED_PORTS.includes(port)) throw new Error(`port ${port} is the installed instance's; a live tool runs only against a second instance`);
  }
  if (typeof m.bind !== 'string' || !['127.0.0.1', '::1'].includes(m.bind)) throw new Error(`the instance binds ${String(m.bind)}; a lifecycle runs beside its instance, on loopback`);
  if (typeof m.tart_home !== 'string' || !isAbsolute(m.tart_home)) throw new Error(`${at} names no Tart store`);
  const env = m.env && typeof m.env === 'object' && !Array.isArray(m.env) ? m.env : {};
  if (env.MACHINE_SERVICE_SECOND_INSTANCE !== m.id) throw new Error(`${at}: the daemon's environment does not mark it second instance ${m.id}`);
  if (typeof env.TART_HOME !== 'string' || !isAbsolute(env.TART_HOME) || canonicalPath(env.TART_HOME) !== canonicalPath(m.tart_home)) throw new Error(`${at}: the daemon's TART_HOME is not the manifest's Tart store`);
  if (env.TART_NO_AUTO_PRUNE !== '1') throw new Error(`${at}: the daemon runs without TART_NO_AUTO_PRUNE=1, so a clone may prune the store's cached images`);
  const store = canonicalPath(m.tart_home), operator = canonicalPath(join(home, '.tart'));
  if (store !== operator && overlaps(store, operator)) throw new Error(`the instance's Tart store ${m.tart_home} lies inside or around the operator's (~/.tart); an instance has a store of its own or the operator's store itself`);
  const origin = new URL(`http://${m.bind.includes(':') ? `[${m.bind}]` : m.bind}:${m.port}`).origin;
  return { id: m.id, root: canonicalPath(root), origin, port: m.port, tartHome: store, operatorStore: store === operator, vmPrefix: vmPrefix(m.id), env: { ...env } };
}

/** The instance under `root`, read from its manifest and refused as {@link secondInstance} says. */
export async function readSecondInstance(root, home) {
  if (!isAbsolute(root)) throw new Error(`--instance ${root} must be an absolute path`);
  const text = await readFile(join(root, MANIFEST), 'utf8').catch(error => {
    throw new Error(`no second instance at ${root}: ${error.code === 'ENOENT' ? `no ${MANIFEST}; start one with machine-service's second-instance launcher` : error.message}`);
  });
  return secondInstance(JSON.parse(text), root, home);
}

/** The instance's own report, `/health`, must carry the launcher's mark with its ID (machine-service DC-245). */
export function confirmMark(instance, health) {
  const id = health?.second_instance?.id;
  if (id !== instance.id) throw new Error(`${instance.origin}/health ${id === undefined ? 'carries no second-instance mark' : `marks instance ${String(id)}, not ${instance.id}`}; a live tool never runs against the installed instance`);
}

/**
 * The instance under `root`, its manifest checked and its `/health` read
 * once and confirmed to carry the manifest's ID. Nothing else is sent.
 */
export async function connectSecondInstance(root, home, fetcher = fetch) {
  const instance = await readSecondInstance(root, home);
  const response = await fetcher(`${instance.origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const health = await response.json();
  confirmMark(instance, health);
  return { instance, health };
}

/** `vm` itself, when the instance made it: its name carries the instance's prefix (DC-246). */
export function ownedVm(instance, vm) {
  if (typeof vm !== 'string' || !vm.startsWith(instance.vmPrefix) || vm.length === instance.vmPrefix.length) throw new Error(`VM ${String(vm)} is not one of second instance ${instance.id}'s clones (${instance.vmPrefix}…); a live tool touches no other VM`);
  return vm;
}

/** Every machine the instance lists is its own clone. */
export function confirmOwnedMachines(instance, list) {
  for (const vm of Object.keys(list?.machines ?? {})) ownedVm(instance, vm);
}

/** The read routes a live tool sends; every other route names an owned VM or is `POST /acquire`. */
const READS = new Set(['/health', '/machines', '/images', '/applications', '/acquisition-capabilities']);

/**
 * Whether a live tool may send `method url` to the instance: only to its
 * origin, a read of its listings, an acquisition, or any route under
 * `/machines/<vm>` of an owned VM. Throws what it refuses.
 */
export function admitRequest(instance, method, url) {
  const parsed = new URL(url);
  if (parsed.origin !== instance.origin) throw new Error(`${parsed.origin} is not second instance ${instance.id}'s origin (${instance.origin})`);
  const machine = /^\/machines\/([^/]+)(?:\/.*)?$/.exec(parsed.pathname);
  if (machine) { ownedVm(instance, decodeURIComponent(machine[1])); return; }
  if (method === 'GET' && READS.has(parsed.pathname)) return;
  if (method === 'POST' && parsed.pathname === '/acquire') return;
  throw new Error(`${method} ${parsed.pathname} is not a route a live tool sends`);
}

/**
 * A fetch that sends only what {@link admitRequest} admits, and fails an
 * acquisition whose VM is not the instance's own clone.
 */
export function instanceTransport(instance, base = fetch) {
  return async (input, init = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    admitRequest(instance, method, url);
    const response = await base(input, init);
    if (method === 'POST' && new URL(url).pathname === '/acquire' && response.ok) ownedVm(instance, (await response.clone().json())?.vm);
    return response;
  };
}

/** The backend methods whose first argument is a VM name. */
const VM_METHODS = new Set(['get', 'exec', 'push', 'pull', 'heartbeat', 'release', 'consoleResolve', 'consoleOpen', 'consoleCancel', 'pushBytes', 'pullBytes', 'useRelay']);

/**
 * The backend, refusing any call that names a VM outside the instance's
 * prefix, and an acquisition that answers one; this covers calls the
 * backend makes over the broker as well as over HTTP.
 */
export function ownedBackend(instance, backend) {
  return new Proxy(backend, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (VM_METHODS.has(key)) return (vm, ...rest) => value.call(target, ownedVm(instance, vm), ...rest);
      if (key === 'acquire') return async (...args) => { const lease = await value.apply(target, args); ownedVm(instance, lease?.vm); return lease; };
      return value.bind(target);
    },
  });
}

/**
 * The folder the daemon's environment names under `variable`, canonical,
 * when it lies under the instance's own root; a live tool writes into no
 * folder the operator or the installed instance reads.
 */
export function ownedFolder(instance, variable) {
  const path = instance.env[variable];
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`second instance ${instance.id} names no ${variable}; start it with --env ${variable}=<a folder under its root>`);
  const folder = canonicalPath(path);
  if (!within(folder, instance.root) || folder === instance.root) throw new Error(`second instance ${instance.id}'s ${variable} ${path} lies outside its root ${instance.root}`);
  return folder;
}

/** A registry path a live tool may use: neither the operator's ~/AGENTS.md nor the relay's default one. */
export function ownRegistry(path, home) {
  for (const operator of [join(home, 'AGENTS.md'), join(home, '.local/state/mcp-relay')]) {
    if (overlaps(path, operator)) throw new Error(`the registry ${path} is the operator's (${operator})`);
  }
  return path;
}

/** `--name value`, once, or undefined; a flag without a value is refused. */
export function flagValue(args, name) {
  const at = args.flatMap((value, index) => value === name ? [index] : []);
  if (at.length > 1) throw new Error(`${name} is given twice`);
  if (!at.length) return undefined;
  const value = args[at[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
