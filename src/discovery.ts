import { MachineService, type VmBackend } from './machine-service.js';
import { browse as mdnsBrowse, type Advertised } from './mdns.js';

/**
 * Finding the machine-service instance that owns a durable machine, the way
 * machctl does (docs/durable-machines.md §2, DC-35): the loopback instance
 * first, then the instances discovery finds in the mode
 * `MACHINE_SERVICE_DISCOVERY` chooses, `bonjour` by default (each instance's
 * Bonjour advertisement) or `consul` (the Consul agent's registrations). An
 * instance found that way is used only once its `/health` answers the ID it
 * was found under, and the relay talks to an origin off loopback only when
 * discovery found it.
 */

/** How instances are found (machine-service DC-84). */
export type DiscoveryMode = 'bonjour' | 'consul';
/** The DNS-SD service every instance advertises (machine-service DC-85). */
export const SERVICE_TYPE = '_machine-service._tcp.local';

/** `MACHINE_SERVICE_DISCOVERY`: `bonjour` when unset or empty, `consul`, or an error naming both. */
export function discoveryMode(value = process.env.MACHINE_SERVICE_DISCOVERY): DiscoveryMode {
  if (!value || value === 'bonjour') return 'bonjour';
  if (value === 'consul') return 'consul';
  throw new Error(`MACHINE_SERVICE_DISCOVERY must be one of bonjour, consul; got ${JSON.stringify(value)}`);
}

/** One `machine-service` registration in Consul's `/v1/health/service` answer. */
export interface Registration { node: string; origin: string; instance?: string; loopbackOnly: boolean }
/** The instance that owns a durable machine: its backend, origin and instance ID. */
export interface DurableOwner { backend: VmBackend; origin: string; instance: string }
export interface DiscoveryOptions {
  /** The loopback instance, asked first. */
  local: VmBackend;
  /** The mode; default `MACHINE_SERVICE_DISCOVERY`. */
  mode?: DiscoveryMode;
  /** Test seam: a Bonjour browse. */
  browse?: () => Promise<Advertised[]>;
  /** The Consul agent; default `CONSUL_HTTP_ADDR`, else `http://127.0.0.1:8500`. */
  consul?: string;
  /** Test seam: the backend for a listed origin. */
  backend?: (origin: string) => VmBackend;
  /** Test seam: Consul's answer. */
  fetchJson?: (url: string) => Promise<unknown>;
}

const TIMEOUT_MS = 5000;

/** `CONSUL_HTTP_ADDR` may name a host and port without a scheme, as Consul's own clients accept. */
export function consulAddress(value = process.env.CONSUL_HTTP_ADDR): string {
  const address = value?.trim() || 'http://127.0.0.1:8500';
  return new URL(/^[a-z]+:\/\//i.test(address) ? address : `http://${address}`).origin;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const text = (value: unknown) => typeof value === 'string' ? value : '';

/** Parse a `/v1/health/service/machine-service` answer: the service's address, else its node's. */
export function parseRegistrations(answer: unknown): Registration[] {
  if (!Array.isArray(answer)) throw new Error('Consul answered with no list of registrations');
  return answer.flatMap(entry => {
    const node = entry?.Node, service = entry?.Service, port = service?.Port;
    const host = text(service?.Address) || text(node?.Address);
    if (!host || !Number.isSafeInteger(port)) return [];
    const meta = service?.Meta ?? {};
    return [{ node: text(node?.Node), origin: new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}`).origin, ...(text(meta.instance) ? { instance: text(meta.instance) } : {}), loopbackOnly: meta.loopback_only === 'true' }];
  });
}

/**
 * The instances to ask besides the loopback one, each with the ID it must
 * confirm: Bonjour advertisements, or Consul registrations (their stated
 * ID, when they state one). A loopback-only registration on another Mac is
 * skipped.
 */
async function candidates(options: DiscoveryOptions, mode: DiscoveryMode): Promise<{ found: Array<{ origin: string; expected?: string }>; error?: string }> {
  if (mode === 'bonjour') {
    try {
      const advertised = await (options.browse ?? (() => mdnsBrowse(SERVICE_TYPE)))();
      return { found: advertised.map(a => ({ origin: new URL(`http://${a.address ?? a.host}:${a.port}`).origin, expected: a.instance })) };
    } catch (error) { return { found: [], error: `the Bonjour browse failed (${error instanceof Error ? error.message : String(error)})` }; }
  }
  const consul = options.consul ?? consulAddress();
  try {
    const rows = parseRegistrations(await (options.fetchJson ?? fetchJson)(`${consul}/v1/health/service/machine-service`));
    return { found: rows.filter(row => !row.loopbackOnly).map(row => ({ origin: row.origin, ...(row.instance ? { expected: row.instance } : {}) })) };
  } catch (error) { return { found: [], error: `the Consul agent at ${consul} did not answer (${error instanceof Error ? error.message : String(error)})` }; }
}

/** The ID an instance's `/health` answers, or why it cannot be used under `expected` (DC-35). */
async function confirmed(backend: VmBackend, expected: string): Promise<string | undefined> {
  const health = await backend.health({ timeoutMs: TIMEOUT_MS }) as { service?: unknown; instance?: unknown };
  if (health.service !== undefined && health.service !== 'machine-service') return `it answers as ${String(health.service)}, not machine-service`;
  if (health.instance !== expected) return `it was found as ${expected}, but its /health answers ${String(health.instance ?? 'no instance')}`;
  return undefined;
}

/**
 * The one instance whose `/machines` lists a durable machine named `machine`.
 * An unreachable or unconfirmed instance is skipped; the same instance found
 * twice, such as the loopback one and its own advertisement, counts once; no
 * owner, or two, is refused.
 */
export async function findDurableOwner(machine: string, options: DiscoveryOptions): Promise<DurableOwner> {
  const mode = options.mode ?? discoveryMode();
  const make = options.backend ?? (origin => new MachineService({ baseUrl: origin, listed: true }));
  const localOrigin = new URL(options.local.baseUrl).origin;
  const { found, error: discoveryError } = await candidates(options, mode);
  const asked: Array<{ origin: string; backend: VmBackend; expected?: string }> = [{ origin: localOrigin, backend: options.local }];
  for (const candidate of found) if (!asked.some(a => a.origin === candidate.origin)) asked.push({ ...candidate, backend: make(candidate.origin) });
  const owners: DurableOwner[] = [];
  const refused: string[] = [];
  await Promise.all(asked.map(async ({ origin, backend, expected }) => {
    try {
      if (expected) { const why = await confirmed(backend, expected); if (why) { refused.push(`${origin}: ${why}`); return; } }
      // `/machines` keys a durable machine's record by its name (MM-3).
      const record = (await backend.list({ timeoutMs: TIMEOUT_MS })).machines[machine];
      if (record?.kind === 'durable') owners.push({ backend, origin, instance: record.instance ?? machine });
    } catch { /* An instance that does not answer owns nothing we can lease. */ }
  }));
  // The loopback instance first, so it wins over its own advertisement or registration.
  owners.sort((a, b) => Number(b.origin === localOrigin) - Number(a.origin === localOrigin));
  const distinct = owners.filter((owner, index) => owners.findIndex(other => other.instance === owner.instance) === index);
  if (distinct.length === 1) return distinct[0]!;
  if (distinct.length > 1) throw new Error(`Durable machine ${machine} is listed by more than one instance (${distinct.map(owner => owner.origin).join(', ')}); nothing was acquired`);
  const hint = mode === 'bonjour' ? 'Check the name with `machctl list`; the Mac\'s machine-service must be bound to all interfaces to advertise itself, or set MACHINE_SERVICE_DISCOVERY=consul to use a Consul agent.' : 'Check the name with `machctl list`, and point CONSUL_HTTP_ADDR at a reachable Consul agent.';
  throw new Error(`No machine-service instance lists a durable machine named ${machine}${discoveryError ? `, and ${discoveryError}` : ''}${refused.length ? `; unconfirmed: ${refused.join('; ')}` : ''}; nothing was acquired. ${hint}`);
}
