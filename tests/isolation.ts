/**
 * The one way a test gives a process its environment (DC-6x-ISO-1): built from
 * an empty allowlist by scripts/isolation.mjs, plus what the test names. A
 * test never copies process.env into a child.
 */
import { delimiter } from 'node:path';
import { ISOLATION_VARIABLE, isolatedEnvironment } from '../scripts/isolation.mjs';

if (process.env[ISOLATION_VARIABLE] !== '1') throw new Error('Run the tests through scripts/test.mjs (npm test), which starts them from an empty environment');

/** A child's environment: the isolated base, then `variables`. */
export function childEnvironment(variables: Record<string, string | undefined> = {}): Record<string, string> {
  const named = Object.fromEntries(Object.entries(variables).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return isolatedEnvironment(named);
}

/** The isolated PATH with the test's own directories, such as its stubs, first. */
export function childPath(...directories: string[]): string {
  return [...directories, isolatedEnvironment().PATH].join(delimiter);
}
