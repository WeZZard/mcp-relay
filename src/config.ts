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

/** MCP_VM_RELAY_STATE_DIR > XDG_STATE_HOME/mcp-vm-relay > ~/.local/state/mcp-vm-relay. */
export function relayStateRoot(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return selected.profile.relayStateDir;
  if (env.MCP_VM_RELAY_STATE_DIR !== undefined) return absolute(env.MCP_VM_RELAY_STATE_DIR, "MCP_VM_RELAY_STATE_DIR");
  if (env.XDG_STATE_HOME !== undefined) return join(absolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "mcp-vm-relay");
  return join(absolute(options.home ?? env.HOME ?? homedir(), "home"), ".local", "state", "mcp-vm-relay");
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

/** Resolve a Python executable name through PATH unless explicitly overridden. */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return nonblank(env.MCP_VM_RELAY_PYTHON ?? "python3", "MCP_VM_RELAY_PYTHON");
}

/** Environment-only diagnostic candidate, not legacy AGENTS.md autodetection. */
export function registryDiagnosticsPath(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return join(selected.profile.relayStateDir, 'registry.md');
  if (env.MCP_VM_RELAY_REGISTRY !== undefined) {
    return absolute(env.MCP_VM_RELAY_REGISTRY, "MCP_VM_RELAY_REGISTRY");
  }
  return join(relayStateRoot(options), "registry.md");
}
