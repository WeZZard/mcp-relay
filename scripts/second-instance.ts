// The machine-service instance a live tool drives: a second instance that
// machine-service's launcher started, never the installed one (DC-6x-ISO2-1).
//
// machine-service's conventions (its DC-243 to DC-246, crate
// `second-instance`): `second-instance start --root DIR --port N
// --session-port N --tart-home DIR` starts one under a root it owns and
// writes `<root>/second-instance.json` before anything else; the daemon then
// reports `second_instance: {id}` in `/health`, and a live client runs only
// against an instance that does, never on port 6240 or 6241, with no
// override. A relay live tool also keeps its own registry and refuses the
// default Tart store, so it touches neither the operator's ~/AGENTS.md nor
// ~/.tart.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { installedOrigin } from '../src/config.js';
import { canonicalPath } from '../src/environment.js';

/** The launcher's manifest under an instance's root. */
export const MANIFEST = 'second-instance.json';
/** The installed instance's HTTP and broker ports, which no second instance has. */
export const INSTALLED_PORTS: readonly number[] = [6240, 6241];
/** A second instance's ID: 1 to 16 lower-case letters and digits (the crate's `valid_id`). */
const ID = /^[a-z0-9]{1,16}$/;

/** What a live tool reaches: the instance's ID, origin and Tart store. */
export interface SecondInstance { id: string; root: string; origin: string; port: number; tartHome: string }

const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
/** Whether one folder lies in the other, or they are the same (the crate's `overlaps`). */
export const overlaps = (a: string, b: string) => { const [x, y] = [canonicalPath(a), canonicalPath(b)]; return within(x, y) || within(y, x); };

/**
 * The second instance the launcher's manifest at `root` describes, refused
 * when it is, or shares anything with, the installed instance of the
 * operator whose home is `home`: the installed ports or origin, a bind
 * address off loopback (a lifecycle runs beside its instance), or the
 * default Tart store.
 */
export function secondInstance(manifest: unknown, root: string, home: string): SecondInstance {
  const m = manifest as { id?: unknown; root?: unknown; port?: unknown; session_port?: unknown; bind?: unknown; tart_home?: unknown } | null;
  if (typeof m?.id !== 'string' || !ID.test(m.id)) throw new Error(`${join(root, MANIFEST)} names no second-instance id`);
  if (typeof m.root !== 'string' || canonicalPath(m.root) !== canonicalPath(root)) throw new Error(`${join(root, MANIFEST)} is the manifest of another root (${String(m.root)})`);
  for (const key of ['port', 'session_port'] as const) {
    const port = m[key];
    if (!Number.isSafeInteger(port) || (port as number) <= 0 || (port as number) > 65535) throw new Error(`${join(root, MANIFEST)}: ${key} is not a port`);
    if (INSTALLED_PORTS.includes(port as number)) throw new Error(`port ${port} is the installed instance's; a live tool runs only against a second instance`);
  }
  if (typeof m.bind !== 'string' || !['127.0.0.1', '::1'].includes(m.bind)) throw new Error(`the instance binds ${String(m.bind)}; a lifecycle runs beside its instance, on loopback`);
  const origin = new URL(`http://${m.bind.includes(':') ? `[${m.bind}]` : m.bind}:${m.port}`).origin;
  if (installedOrigin(origin)) throw new Error(`${origin} is the installed machine-service's origin`);
  if (typeof m.tart_home !== 'string' || !isAbsolute(m.tart_home)) throw new Error(`${join(root, MANIFEST)} names no Tart store`);
  if (overlaps(m.tart_home, join(home, '.tart'))) throw new Error(`the instance's Tart store ${m.tart_home} is the default one (~/.tart); a live tool runs on a Tart store of its own`);
  return { id: m.id, root: canonicalPath(root), origin, port: m.port as number, tartHome: canonicalPath(m.tart_home) };
}

/** The instance under `root`, read from its manifest and refused as {@link secondInstance} says. */
export async function readSecondInstance(root: string, home: string): Promise<SecondInstance> {
  if (!isAbsolute(root)) throw new Error(`--instance ${root} must be an absolute path`);
  const text = await readFile(join(root, MANIFEST), 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw new Error(`no second instance at ${root}: ${error.code === 'ENOENT' ? `no ${MANIFEST}; start one with machine-service's second-instance launcher` : error.message}`);
  });
  return secondInstance(JSON.parse(text), root, home);
}

/** The instance's own report, `/health`, must carry the launcher's mark with its ID (machine-service DC-245). */
export function confirmMark(instance: SecondInstance, health: unknown): void {
  const id = (health as { second_instance?: { id?: unknown } } | null)?.second_instance?.id;
  if (id !== instance.id) throw new Error(`${instance.origin}/health ${id === undefined ? 'carries no second-instance mark' : `marks instance ${String(id)}, not ${instance.id}`}; a live tool never runs against the installed instance`);
}

/** A registry path a live tool may use: neither the operator's ~/AGENTS.md nor the relay's default one. */
export function ownRegistry(path: string, home: string): string {
  for (const operator of [join(home, 'AGENTS.md'), join(home, '.local/state/mcp-relay')]) {
    if (overlaps(path, operator)) throw new Error(`the registry ${path} is the operator's (${operator})`);
  }
  return path;
}

/** `--name value`, once, or undefined; a flag without a value is refused. */
export function flagValue(args: readonly string[], name: string): string | undefined {
  const at = args.flatMap((value, index) => value === name ? [index] : []);
  if (at.length > 1) throw new Error(`${name} is given twice`);
  if (!at.length) return undefined;
  const value = args[at[0]! + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
