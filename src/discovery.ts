import { MachineService, type VmBackend } from './machine-service.js';

/**
 * Finding the machine-service instance that owns a durable machine, the way
 * machctl does (docs/durable-machines.md §2, DC-29): the loopback instance
 * first, then every `machine-service` registration the Consul agent lists.
 * The relay talks to an origin off loopback only when Consul listed it.
 */

/** One `machine-service` registration in Consul's `/v1/health/service` answer. */
export interface Registration { node: string; origin: string; instance?: string; loopbackOnly: boolean }
/** The instance that owns a durable machine: its backend, origin and instance ID. */
export interface DurableOwner { backend: VmBackend; origin: string; instance: string }
export interface DiscoveryOptions {
  /** The loopback instance, asked first. */
  local: VmBackend;
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
 * The one instance whose `/machines` lists a durable machine named `machine`.
 * An unreachable instance is skipped; no owner, or two, is refused.
 */
export async function findDurableOwner(machine: string, options: DiscoveryOptions): Promise<DurableOwner> {
  const consul = options.consul ?? consulAddress();
  const make = options.backend ?? (origin => new MachineService({ baseUrl: origin, listed: true }));
  const candidates: Array<{ origin: string; backend: VmBackend }> = [{ origin: new URL(options.local.baseUrl).origin, backend: options.local }];
  let consulError: string | undefined;
  try {
    for (const registration of parseRegistrations(await (options.fetchJson ?? fetchJson)(`${consul}/v1/health/service/machine-service`))) {
      if (registration.loopbackOnly || candidates.some(candidate => candidate.origin === registration.origin)) continue;
      candidates.push({ origin: registration.origin, backend: make(registration.origin) });
    }
  } catch (error) { consulError = `the Consul agent at ${consul} did not answer (${error instanceof Error ? error.message : String(error)})`; }
  const owners: DurableOwner[] = [];
  await Promise.all(candidates.map(async ({ origin, backend }) => {
    try {
      const list = await backend.list({ timeoutMs: TIMEOUT_MS });
      // `/machines` keys a durable machine's record by its name (MM-3).
      const record = list.machines[machine];
      if (record?.kind === 'durable') owners.push({ backend, origin, instance: record.instance ?? machine });
    } catch { /* An instance that does not answer owns nothing we can lease. */ }
  }));
  if (owners.length === 1) return owners[0]!;
  if (owners.length > 1) throw new Error(`Durable machine ${machine} is listed by more than one instance (${owners.map(owner => owner.origin).join(', ')}); nothing was acquired`);
  throw new Error(`No machine-service instance lists a durable machine named ${machine}${consulError ? `, and ${consulError}` : ''}; nothing was acquired. Check the name with \`machctl list\`, and point CONSUL_HTTP_ADDR at a reachable Consul agent.`);
}
