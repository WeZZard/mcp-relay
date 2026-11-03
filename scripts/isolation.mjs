// The environment every test process gets: built from an empty allowlist,
// never copied from the shell that started the tests (DC-61).
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
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export const ISOLATION_VARIABLE = 'MCP_RELAY_ISOLATED';
/** The prefix of the shell variables the test runner passes on: the tests' own inputs. */
export const TEST_INPUT_PREFIX = 'MCP_RELAY_TEST_';
/** The directory of the explicit tool links scripts/test.mjs makes (node, python3), set on the runner. */
export const TOOLS_VARIABLE = 'MCP_RELAY_TEST_TOOLS';
/** The tests' python3: an absolute path the shell names, and the runner records once resolved. */
export const PYTHON_VARIABLE = 'MCP_RELAY_TEST_PYTHON';
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

const executableFile = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };

/**
 * The python3 the tests run (DC-69), resolved once at startup to the
 * real file it names, so neither a later PATH nor a moved link can swap it:
 * MCP_RELAY_TEST_PYTHON, which must be an absolute path to an executable,
 * else the first python3 on the caller's PATH. CI must name it; a CI run
 * (CI set) never looks on PATH. Throws, with what to set, otherwise.
 */
export function testPython(env = process.env) {
  const named = env[PYTHON_VARIABLE];
  if (named !== undefined) {
    if (!isAbsolute(named)) throw new Error(`${PYTHON_VARIABLE} must be an absolute path; got ${JSON.stringify(named)}`);
    if (!executableFile(named)) throw new Error(`${PYTHON_VARIABLE}=${named} is not an executable file`);
    return realpathSync(named);
  }
  if (env.CI) throw new Error(`CI must name the tests' python3 with ${PYTHON_VARIABLE}, an absolute path; it is not taken from PATH`);
  const found = (env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, 'python3')).find(executableFile);
  if (!found) throw new Error(`no python3 on PATH; name one with ${PYTHON_VARIABLE}, an absolute path`);
  return realpathSync(found);
}
