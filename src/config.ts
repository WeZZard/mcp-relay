import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { selectedEnvironment } from './environment.js';

/** Injectable process context; resolving configuration never creates files. */
export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function nonblank(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new TypeError(`${label} must be nonblank text without NUL characters`);
  return value;
}

export function absolute(value: string, label: string): string {
  nonblank(value, label);
  if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return normalize(value);
}

/**
 * Whether this host can run the local Tart/machine-service backend: an
 * Apple-silicon Mac. Elsewhere, such as Ubuntu, the relay is a client of a
 * machine-service instance on another host (DC-42).
 */
export function localTartHost(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

/** The origin an installed machine-service listens on, which the relay uses when nothing names another. */
export const INSTALLED_SERVICE_URL = 'http://localhost:6240';
/** The variable the test harness sets on every process it starts (scripts/isolation.mjs, DC-61). */
export const ISOLATION_VARIABLE = 'MCP_RELAY_ISOLATED';

/** Whether the process was started by the test harness, which gives the relay no defaults (DC-61). */
export function isolated(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ISOLATION_VARIABLE] === '1';
}

/** Whether an origin is the installed instance's: its port on any loopback name. */
export function installedOrigin(url: string): boolean {
  const parsed = new URL(url);
  return parsed.port === new URL(INSTALLED_SERVICE_URL).port && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

/**
 * The machine-service origin a process uses: the selected environment's, then
 * MCP_RELAY_URL, then the installed instance's. A process the test harness
 * started gets no default and is refused the installed instance's origin
 * however it is named, so no test reaches the real service (DC-61).
 */
export function serviceUrl(env: NodeJS.ProcessEnv = process.env, environment = selectedEnvironment(env)): string {
  const named = environment?.profile.vmServiceUrl ?? env.MCP_RELAY_URL;
  if (!isolated(env)) return named ?? INSTALLED_SERVICE_URL;
  if (named === undefined) throw new Error(`${ISOLATION_VARIABLE}=1: name the machine-service origin with MCP_RELAY_URL or VM_ENVIRONMENT_FILE; a test gets no default`);
  if (installedOrigin(named)) throw new Error(`${ISOLATION_VARIABLE}=1: ${named} is the installed machine-service's origin, which no test may reach`);
  return named;
}

/** MCP_RELAY_STATE_DIR > XDG_STATE_HOME/mcp-relay > ~/.local/state/mcp-relay. */
export function relayStateRoot(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return selected.profile.relayStateDir;
  if (env.MCP_RELAY_STATE_DIR !== undefined) return absolute(env.MCP_RELAY_STATE_DIR, "MCP_RELAY_STATE_DIR");
  if (env.XDG_STATE_HOME !== undefined) return join(absolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "mcp-relay");
  return join(absolute(options.home ?? env.HOME ?? homedir(), "home"), ".local", "state", "mcp-relay");
}

/** The networks a guest may be acquired on (DC-17). */
export const GUEST_NETWORKS = ['nat', 'internet'] as const;
export type GuestNetwork = typeof GUEST_NETWORKS[number];
/**
 * The network every guest is acquired on, from MCP_RELAY_GUEST_NETWORK:
 * `nat` when it is unset, `internet` for a guest that reaches the internet
 * and neither the host nor a private network. Any other value is refused,
 * never read as `nat` (DC-17).
 */
export function guestNetwork(env: NodeJS.ProcessEnv = process.env): GuestNetwork {
  const value = env.MCP_RELAY_GUEST_NETWORK;
  if (value === undefined) return 'nat';
  if (!(GUEST_NETWORKS as readonly string[]).includes(value)) throw new TypeError(`MCP_RELAY_GUEST_NETWORK must be nat or internet, not ${JSON.stringify(value)}; no guest is acquired until it names one of them`);
  return value as GuestNetwork;
}

/** How many guests one session holds at once when MCP_RELAY_MAX_GUESTS is unset (DC-20). */
export const DEFAULT_MAX_GUESTS = 4;
/**
 * The most guests one relay session holds at once, from MCP_RELAY_MAX_GUESTS:
 * 4 when it is unset. Anything but a positive integer is refused, never read
 * as the default (DC-20).
 */
export function maxGuests(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.MCP_RELAY_MAX_GUESTS;
  if (value === undefined) return DEFAULT_MAX_GUESTS;
  const count = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(count)) throw new TypeError(`MCP_RELAY_MAX_GUESTS must be a positive integer, not ${JSON.stringify(value)}; no guest is acquired until it names one`);
  return count;
}

/** How long relay_acquire waits for capacity when MCP_RELAY_CAPACITY_WAIT is unset, in seconds (DC-22). */
export const DEFAULT_CAPACITY_WAIT_S = 1800;
/**
 * How long relay_acquire waits for a host at capacity, from
 * MCP_RELAY_CAPACITY_WAIT in whole seconds: 1800 when it is unset, 0 for not
 * at all. Anything but a nonnegative integer is refused (DC-22).
 */
export function capacityWait(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.MCP_RELAY_CAPACITY_WAIT;
  if (value === undefined) return DEFAULT_CAPACITY_WAIT_S;
  const seconds = /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds)) throw new TypeError(`MCP_RELAY_CAPACITY_WAIT must be a nonnegative integer of seconds, not ${JSON.stringify(value)}; the relay does not start until it names one`);
  return seconds;
}

/** What the end of a session does to its guests (DC-21). */
export const ON_EXIT = ['pause', 'release'] as const;
export type OnExit = typeof ON_EXIT[number];
/**
 * What the end of a session does to its guests, from MCP_RELAY_ON_EXIT:
 * `pause`, when it is unset, pauses each guest's renewal and keeps its VM;
 * `release` releases every guest. Any other value is refused (DC-21).
 */
export function onExit(env: NodeJS.ProcessEnv = process.env): OnExit {
  const value = env.MCP_RELAY_ON_EXIT;
  if (value === undefined) return 'pause';
  if (!(ON_EXIT as readonly string[]).includes(value)) throw new TypeError(`MCP_RELAY_ON_EXIT must be pause or release, not ${JSON.stringify(value)}; the relay does not start until it names one of them`);
  return value as OnExit;
}

/** Resolve a Python executable name through PATH unless explicitly overridden. */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return nonblank(env.MCP_RELAY_PYTHON ?? "python3", "MCP_RELAY_PYTHON");
}

/** Environment-only diagnostic candidate, not legacy AGENTS.md autodetection. */
export function registryDiagnosticsPath(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return join(selected.profile.relayStateDir, 'registry.md');
  if (env.MCP_RELAY_REGISTRY !== undefined) {
    return absolute(env.MCP_RELAY_REGISTRY, "MCP_RELAY_REGISTRY");
  }
  return join(relayStateRoot(options), "registry.md");
}

/**
 * How the relay reaches a broker that sits behind an edge it cannot reach by
 * ordinary DNS or public roots, such as the relay acceptance's network rig
 * (machine-service TL-7), the way curl's --resolve and --cacert do:
 * MCP_RELAY_BROKER_RESOLVE=<host name>=<IP address>[:<port>] connects that one
 * name to that address, and to that port when one is given, and MCP_RELAY_BROKER_CA=<absolute path of a PEM file> trusts
 * one more authority besides the public roots and the instance's own. Both
 * are unset in ordinary use.
 */
export interface BrokerRoute { resolve?: { host: string; address: string; port?: number }; caPem?: string }
export function brokerRoute(env: NodeJS.ProcessEnv = process.env): BrokerRoute {
  const route: BrokerRoute = {};
  const resolve = env.MCP_RELAY_BROKER_RESOLVE;
  if (resolve !== undefined && resolve !== '') {
    const at = resolve.indexOf('=');
    const host = resolve.slice(0, at).toLowerCase(), target = resolve.slice(at + 1);
    // An address alone, an IPv4 address and port, or a bracketed IPv6 address and port.
    const withPort = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:\[\]]+):(\d+)$/.exec(target);
    const address = withPort ? withPort[1]! : target, port = withPort ? Number(withPort[2]) : undefined;
    if (at <= 0 || !/^[a-z0-9.-]+$/.test(host) || isIP(address) === 0 || (port !== undefined && !(port > 0 && port < 65536))) throw new TypeError(`MCP_RELAY_BROKER_RESOLVE must be <host name>=<IP address>[:<port>], not ${JSON.stringify(resolve)}`);
    route.resolve = port === undefined ? { host, address } : { host, address, port };
  }
  const ca = env.MCP_RELAY_BROKER_CA;
  if (ca !== undefined && ca !== '') {
    const pem = readFileSync(absolute(ca, 'MCP_RELAY_BROKER_CA'), 'utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new TypeError('MCP_RELAY_BROKER_CA must name a PEM certificate file');
    route.caPem = pem;
  }
  return route;
}
