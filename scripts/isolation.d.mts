/** Types for isolation.mjs, which the tests and scripts/test.mjs share as plain JavaScript. */
export const ISOLATION_VARIABLE: 'MCP_RELAY_ISOLATED';
export const TEST_INPUT_PREFIX: 'MCP_RELAY_TEST_';
export const TOOLS_VARIABLE: 'MCP_RELAY_TEST_TOOLS';
export const PYTHON_VARIABLE: 'MCP_RELAY_TEST_PYTHON';
export const SYSTEM_PATH: string[];
export const EMPTY_HOME: string;
export function isolatedEnvironment(variables?: Record<string, string>, tools?: string): Record<string, string>;
export function testInputs(env?: NodeJS.ProcessEnv): Record<string, string>;
export function testPython(env?: NodeJS.ProcessEnv): string;
