import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';

export interface VmEnvironment {
  schemaVersion: 1;
  id: string;
  vmServiceUrl: string;
  imageRepository: string;
  tartHome: string;
  serviceStateDir: string;
  imageStateDir: string;
  relayStateDir: string;
  vmctlPath: string;
  tartPath: string;
}
export interface EnvironmentIdentity {
  id: string;
  fingerprint: string;
  vmServiceUrl: string;
  imageRepository: string;
  tartHome: string;
  serviceStateDir: string;
  imageStateDir: string;
  relayStateDir: string;
}
export interface SelectedEnvironment {
  path: string;
  profile: Readonly<VmEnvironment>;
  identity: Readonly<EnvironmentIdentity>;
}
const paths = ['imageRepository', 'tartHome', 'serviceStateDir', 'imageStateDir', 'relayStateDir', 'vmctlPath', 'tartPath'] as const;
const mutable = ['tartHome', 'serviceStateDir', 'imageStateDir', 'relayStateDir'] as const;

/** Resolve existing ancestors without creating a store, lock, or state directory. */
export function canonicalPath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || !value.trim() || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) throw new Error('Environment paths must be absolute and contain no control characters');
  let ancestor = resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Dangling environment path symlink'); }
      catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError; }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor)); ancestor = parent;
    }
  }
}
function overlaps(a: string, b: string): boolean {
  const below = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r)); };
  return below(a, b) || below(b, a);
}
function endpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('vmServiceUrl must be a loopback HTTP origin with an explicit port');
  const match = /^http:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]):([0-9]{1,5})\/?$/.exec(value);
  if (!match || (!['localhost', '[::1]'].includes(match[1]) && isIP(match[1]) !== 4)) throw new Error('vmServiceUrl must be a loopback HTTP origin with an explicit port');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Environment port must be between 1 and 65535');
  return `http://${match[1]}:${port}`;
}

export function loadEnvironment(path: string, env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): SelectedEnvironment {
  const canonical = canonicalPath(resolve(path));
  const info = statSync(canonical);
  if (!info.isFile() || info.size > 65536) throw new Error('Environment profile must be a regular JSON file under 64 KiB');
  const bytes = readFileSync(canonical);
  if (bytes.length > 65536) throw new Error('Environment profile exceeds 64 KiB');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const raw: unknown = JSON.parse(text);
  // Profiles are flat JSON objects. Detect duplicate decoded root keys before
  // JSON.parse's last-value-wins behavior can hide an ambiguous dependency.
  let depth = 0;
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (depth === 1 && text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (seen.has(key)) throw new Error(`Duplicate environment profile key: ${key}`);
        seen.add(key);
      }
    } else if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth--;
  }
  const fields = ['schemaVersion', 'id', 'vmServiceUrl', ...paths].sort();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(fields)) throw new Error('Environment profile has missing or unknown fields');
  const p = raw as VmEnvironment;
  if (p.schemaVersion !== 1 || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)) throw new Error('Invalid environment schemaVersion or id');
  const profile = { schemaVersion: 1, id: p.id, vmServiceUrl: endpoint(p.vmServiceUrl) } as VmEnvironment;
  for (const key of paths) profile[key] = canonicalPath(p[key]);
  if (!statSync(profile.imageRepository).isDirectory() || !statSync(join(profile.imageRepository, 'images')).isDirectory()) throw new Error('Selected imageRepository must contain images/');
  for (const key of ['vmctlPath', 'tartPath'] as const) {
    if (!statSync(profile[key]).isFile()) throw new Error(`${key} must be a regular executable file`);
    accessSync(profile[key], constants.X_OK);
  }
  const state = env.XDG_STATE_HOME ? canonicalPath(env.XDG_STATE_HOME) : join(canonicalPath(home), '.local/state');
  // The relay's default state root is mcp-relay; mcp-vm-relay, its name before
  // the rename (DC-16), stays a legacy root that vm-service also refuses.
  const names = ['vm-service', 'pilot-images', 'mcp-relay', 'mcp-vm-relay'];
  const defaults = [join(canonicalPath(home), '.tart'), ...names.map(n => join(state, n)), ...names.map(n => join(canonicalPath(home), '.local/state', n))].map(canonicalPath);
  for (const key of mutable) {
    const value = profile[key];
    try { if (!statSync(value).isDirectory()) throw new Error(`${key} must be a directory`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (overlaps(value, profile.imageRepository) || defaults.some(root => overlaps(value, root))) throw new Error(`${key} overlaps the repository or a legacy default store/state root`);
    for (const other of mutable) if (key !== other && overlaps(value, profile[other])) throw new Error('Environment mutable roots must be disjoint');
  }
  const ordered = Object.fromEntries(Object.keys(profile).sort().map(k => [k, profile[k as keyof VmEnvironment]]));
  const fingerprint = createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
  const identity = Object.freeze({ id: profile.id, fingerprint, vmServiceUrl: profile.vmServiceUrl, imageRepository: profile.imageRepository,
    tartHome: profile.tartHome, serviceStateDir: profile.serviceStateDir, imageStateDir: profile.imageStateDir, relayStateDir: profile.relayStateDir });
  return Object.freeze({ path: canonical, profile: Object.freeze(profile), identity });
}

export function selectedEnvironment(env: NodeJS.ProcessEnv = process.env, home?: string): SelectedEnvironment | undefined {
  if (env.VM_ENVIRONMENT_FILE === undefined) return undefined;
  if (!env.VM_ENVIRONMENT_FILE.trim()) throw new Error('VM_ENVIRONMENT_FILE must not be blank');
  return loadEnvironment(env.VM_ENVIRONMENT_FILE, env, home);
}

export function environmentVariables(selected: SelectedEnvironment): NodeJS.ProcessEnv {
  const p = selected.profile;
  const url = new URL(p.vmServiceUrl);
  return { VM_ENVIRONMENT_FILE: selected.path, VM_ENVIRONMENT_FINGERPRINT: selected.identity.fingerprint, PILOT_REPO: p.imageRepository, TART_HOME: p.tartHome,
    VM_SERVICE_STATE: p.serviceStateDir, PILOT_IMAGES_STATE_DIR: p.imageStateDir, VM_RELAY_STATE_DIR: p.relayStateDir,
    VM_RELAY_URL: p.vmServiceUrl, VM_SERVICE_HOST: url.hostname.replace(/^\[|\]$/g, ''), VM_SERVICE_PORT: String(Number(p.vmServiceUrl.match(/:([0-9]+)$/)![1])),
    VMCTL: p.vmctlPath, TART: p.tartPath };
}

export function matchesEnvironment(actual: unknown, selected: SelectedEnvironment): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const identity = actual as Record<string, unknown>;
  return Object.keys(identity).length === Object.keys(selected.identity).length && Object.entries(selected.identity).every(([key, value]) => identity[key] === value);
}
