import { Type, StringEnum } from './typebox.js';
import { Check } from 'typebox/value';
import type { Static } from 'typebox';

const closed = { additionalProperties: false };
// Explicit ECMAScript whitespace; do not use language-dependent blank tests.
const whitespace = '\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
// TypeBox uses UTF-16 lengths. Scalar bounds are enforced in validateCatalog.
// Accept paired UTF-16 surrogates only, even when compiled without the u flag.
const text = () => Type.String({ minLength: 1, pattern: `^(?![${whitespace}]*$)(?:[^\\u0000-\\u001f\\ud800-\\udfff]|[\\ud800-\\udbff][\\udc00-\\udfff])+(?![\\s\\S])` });
const application = Type.Object({
  id: text(), name: text(), aliases: Type.Array(text(), { maxItems: 16 }),
  version: Type.Union([text(), Type.Null()]),
}, closed);
export const catalogSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  images: Type.Array(Type.Object({
    image: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\\s\\S])' }),
    os: StringEnum(['linux', 'macos'] as const),
    architecture: StringEnum(['arm64', 'x86_64'] as const),
    applications: Type.Array(application, { maxItems: 20000 }),
  }, closed), { maxItems: 64 }),
}, closed);
export type ApplicationCatalog = Static<typeof catalogSchema>;
export interface SearchQuery { name: string; os?: 'linux' | 'macos' }
export interface Installation { image: string; version: string | null; os: 'linux' | 'macos'; architecture: string }
export interface SearchResult { applications: Array<{ name: string; installations: Installation[] }>; truncated: boolean }
export const SEARCH_LIMITS = Object.freeze({ installations: 100, bytes: 50000, lines: 1900 });
const compare = (a: string, b: string) => {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
};
export const normalizeSearchName = (name: string) => name.trim().toLowerCase();
export const serializeSearchResult = (result: SearchResult) => JSON.stringify(result, null, 2);

export function validateCatalog(value: unknown): asserts value is ApplicationCatalog {
  if (!Check(catalogSchema, value)) throw new Error('Invalid application catalog schema');
  const bounded = (text: string, limit: number) => {
    if (Array.from(text).length > limit) throw new Error('Application catalog exceeds text limit');
  };
  for (const image of value.images) for (const app of image.applications) {
    bounded(app.id, 128);
    bounded(app.name, 256);
    for (const alias of app.aliases) bounded(alias, 256);
    if (app.version !== null) bounded(app.version, 256);
  }
  if (value.images.reduce((n, image) => n + image.applications.length, 0) > 20000) throw new Error('Application catalog exceeds installation limit');
}

type Match = { id: string; name: string; rank: number; installations: Installation[] };
function checkQuery(query: SearchQuery) {
  if (typeof query.name !== 'string' || !query.name.trim()) throw new Error('Search name must be nonblank');
  if (query.os !== undefined && query.os !== 'linux' && query.os !== 'macos') throw new Error('Invalid search OS');
}
const byRank = (a: Match, b: Match) => a.rank - b.rank || compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name) || compare(a.id, b.id);

/** Pure matching: never touches a VM, registry, filesystem or lifecycle state. */
export function searchCatalog(value: unknown, query: SearchQuery): SearchResult {
  checkQuery(query);
  const result: SearchResult = { applications: [], truncated: false };
  return budget(result, matchCatalog(value, query));
}

/** Every application of one catalog that matches, best first, with its installations sorted by image. */
function matchCatalog(value: unknown, query: SearchQuery): Match[] {
  validateCatalog(value);
  const needle = normalizeSearchName(query.name);
  const groups = new Map<string, { name: string; aliases: Set<string>; installations: Map<string, Installation> }>();
  const imageFacts = new Map<string, string>();
  for (const image of value.images) {
    const facts = `${image.os}/${image.architecture}`;
    if (imageFacts.has(image.image) && imageFacts.get(image.image) !== facts) throw new Error('Conflicting catalog image facts');
    imageFacts.set(image.image, facts);
    for (const app of image.applications) {
      let group = groups.get(app.id);
      if (!group) { group = { name: app.name, aliases: new Set(), installations: new Map() }; groups.set(app.id, group); }
      if (group.name !== app.name) throw new Error('Conflicting canonical application names');
      if (!query.os || image.os === query.os) for (const alias of app.aliases) group.aliases.add(alias);
      const installation: Installation = { image: image.image, version: app.version, os: image.os, architecture: image.architecture };
      const previous = group.installations.get(image.image);
      if (previous && JSON.stringify(previous) !== JSON.stringify(installation)) throw new Error('Conflicting application installation facts');
      group.installations.set(image.image, installation);
    }
  }
  const matches = [...groups].flatMap(([id, group]) => {
    const installations = [...group.installations.values()].filter(i => !query.os || i.os === query.os).sort((a, b) => compare(a.image, b.image));
    if (!installations.length) return [];
    let rank = 3;
    for (const name of [group.name, ...group.aliases]) {
      const candidate = name.toLowerCase();
      rank = Math.min(rank, candidate === needle ? 0 : candidate.startsWith(needle) ? 1 : candidate.includes(needle) ? 2 : 3);
      if (rank === 0) break;
    }
    return rank === 3 ? [] : [{ id, name: group.name, rank, installations }];
  });
  return matches.sort(byRank);
}

/**
 * Take a prefix of complete installations within SEARCH_LIMITS, serializing
 * `result` as it grows, and mark it truncated when any is left out.
 */
function budget<I, R extends { applications: Array<{ name: string; installations: I[] }>; truncated: boolean }>(result: R, matches: Array<{ name: string; installations: I[] }>): R {
  let count = 0;
  for (const match of matches) {
    const group = { name: match.name, installations: [] as I[] };
    result.applications.push(group);
    for (const installation of match.installations) {
      group.installations.push(installation);
      const serialized = JSON.stringify(result, null, 2);
      if (count === SEARCH_LIMITS.installations || Buffer.byteLength(serialized) > SEARCH_LIMITS.bytes || serialized.split('\n').length > SEARCH_LIMITS.lines) {
        group.installations.pop();
        if (!group.installations.length) result.applications.pop();
        result.truncated = true;
        return result;
      }
      count++;
    }
  }
  return result;
}

/** An instance as a search result names it (machine-service FD-7). */
export interface InstanceRef { instance: string; machine_id: string | null }
/** One instance's catalog, or why there is none. */
export interface InstanceCatalog extends InstanceRef { origin: string; local: boolean; reachable: boolean; catalog?: unknown; generation?: number | null; status?: string | null; error?: string }
/** An installation, and the instances that offer it with that version, each with its catalog generation. */
export interface FederatedInstallation extends Installation { instances: Array<InstanceRef & { generation: number | null }> }
export interface FederatedSearchResult {
  applications: Array<{ name: string; installations: FederatedInstallation[] }>;
  /** Every instance asked: whether it answered, and its catalog's generation and status, or its error. */
  instances: Array<Omit<InstanceCatalog, 'catalog'>>;
  /** Why discovery found no instance beyond the loopback one, when it could not look. */
  discovery?: string;
  truncated: boolean;
}

/**
 * Search every instance's catalog (machine-service FD-7). Each catalog is
 * matched on its own, as one catalog is; an installation that two instances
 * offer with the same facts is listed once with both, and one whose facts
 * differ between instances, such as a version not yet synced, is listed once
 * per version. An instance that did not answer, or whose catalog is invalid,
 * is reported in `instances` with its error; only when no instance answered
 * with a valid catalog is the search an error, never an empty result.
 */
export function searchInstances(catalogs: InstanceCatalog[], query: SearchQuery, discovery?: string): FederatedSearchResult {
  checkQuery(query);
  const merged = new Map<string, Omit<Match, 'installations'> & { installations: FederatedInstallation[] }>();
  const reported: FederatedSearchResult['instances'] = [];
  for (const { catalog, ...entry } of catalogs) {
    let matches: Match[] | undefined;
    if (entry.reachable && !entry.error) {
      try { matches = matchCatalog(catalog, query); }
      catch (error) { entry.error = `invalid application catalog: ${error instanceof Error ? error.message : String(error)}`; }
    }
    reported.push(entry);
    for (const match of matches ?? []) {
      const known = merged.get(match.id) ?? { id: match.id, name: match.name, rank: match.rank, installations: [] };
      known.rank = Math.min(known.rank, match.rank);
      merged.set(match.id, known);
      for (const installation of match.installations) {
        const same = known.installations.find(other => other.image === installation.image && other.version === installation.version && other.os === installation.os && other.architecture === installation.architecture);
        const offer = { instance: entry.instance, machine_id: entry.machine_id, generation: entry.generation ?? null };
        if (same) same.instances.push(offer);
        else known.installations.push({ ...installation, instances: [offer] });
      }
    }
  }
  if (!reported.some(entry => entry.reachable && !entry.error)) {
    throw new Error(`No machine-service instance answered with an application catalog: ${reported.map(entry => `${entry.instance} (${entry.origin}): ${entry.error ?? 'no answer'}`).join('; ')}${discovery ? `; ${discovery}` : ''}`);
  }
  const matches = [...merged.values()].map(match => ({ ...match, installations: match.installations.sort((a, b) => compare(a.image, b.image) || compare(String(a.version), String(b.version))) })).sort(byRank);
  const result: FederatedSearchResult = { applications: [], instances: reported, ...(discovery ? { discovery } : {}), truncated: false };
  return budget(result, matches);
}
