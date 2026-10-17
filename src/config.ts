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
