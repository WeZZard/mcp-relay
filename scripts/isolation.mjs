// The environment every test process gets: built from an empty allowlist,
// never copied from the shell that started the tests (DC-6x-ISO-1).
//
// The shell may select a real instance (VM_ENVIRONMENT_FILE), point at the
// installed service (MCP_RELAY_URL, MACHINE_SERVICE_URL), at real tools
// (MACHCTL, TART) or at the operator's stores (TART_HOME, HOME). None of that
// reaches a test: scripts/test.mjs starts the test runner with this
// environment, and every test that starts a process gives it this
// environment plus the variables that test names. MCP_RELAY_ISOLATED=1 tells
// the relay it was started by a test, so it supplies no default origin and
// refuses the installed instance's (src/config.ts serviceUrl).
//
// A test's own inputs cross from the shell only under the MCP_RELAY_TEST_
// prefix, such as MCP_RELAY_TEST_MACHCTL; the test decides what each means.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';

export const ISOLATION_VARIABLE = 'MCP_RELAY_ISOLATED';
/** The prefix of the shell variables the test runner passes on: the tests' own inputs. */
export const TEST_INPUT_PREFIX = 'MCP_RELAY_TEST_';
/** The directory of the explicit tool links scripts/test.mjs makes (node, python3), set on the runner. */
export const TOOLS_VARIABLE = 'MCP_RELAY_TEST_TOOLS';
/** The system directories, which hold no installed machctl, Tart or service. */
export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** HOME when a test names none: a directory that holds nothing of the operator's. */
export const EMPTY_HOME = '/var/empty';

/**
 * A child's environment: only what this function sets, then `variables`.
 * PATH is the runner's tool links and the system directories; the rest of
 * the shell's PATH, where an installed machctl or Tart lives, is not on it.
 */
export function isolatedEnvironment(variables = {}, tools = process.env[TOOLS_VARIABLE]) {
  return {
    PATH: [...(tools ? [tools] : []), ...SYSTEM_PATH].join(delimiter),
    HOME: EMPTY_HOME,
    LANG: 'C.UTF-8',
    // The temporary directory, resolved: some checks refuse a symlinked ancestor such as /tmp.
    TMPDIR: realpathSync(tmpdir()),
    [ISOLATION_VARIABLE]: '1',
    ...(tools ? { [TOOLS_VARIABLE]: tools } : {}),
    ...variables,
  };
}

/** The test inputs the shell names, by the convention's prefix. */
export function testInputs(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => name.startsWith(TEST_INPUT_PREFIX) && name !== TOOLS_VARIABLE && value !== undefined));
}
