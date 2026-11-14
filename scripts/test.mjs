// Run the tests in an environment built from an empty allowlist (DC-61).
//
//   node scripts/test.mjs [node --test arguments...]
//
// The runner gets scripts/isolation.mjs's environment: the system PATH plus a
// private directory linking this node, its npm and one python3, an empty HOME,
// MCP_RELAY_ISOLATED=1, and the shell's MCP_RELAY_TEST_* inputs. Nothing else
// in the shell, such as VM_ENVIRONMENT_FILE, MCP_RELAY_URL, MACHCTL, TART or
// TART_HOME, reaches a test. python3 is resolved once, here, to the real file
// MCP_RELAY_TEST_PYTHON names (an absolute path; CI must name it), else to the
// first on the shell's PATH, and the runner records it as MCP_RELAY_TEST_PYTHON
// (DC-69): the tests need a Python 3 with fcntl, not any
// machine-service tool.
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PYTHON_VARIABLE, isolatedEnvironment, testInputs, testPython } from './isolation.mjs';

const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
let python;
try { python = testPython(); } catch (error) { console.error(`scripts/test.mjs: ${error.message}`); process.exit(2); }

const tools = mkdtempSync(join(tmpdir(), 'mcp-relay-test-tools-'));
symlinkSync(process.execPath, join(tools, 'node'));
symlinkSync(python, join(tools, 'python3'));
// npm is this node's own, beside it, for the test that packs the package.
const npm = join(dirname(process.execPath), 'npm');
if (executable(npm)) symlinkSync(npm, join(tools, 'npm'));
const cleanup = () => rmSync(tools, { recursive: true, force: true });

const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const child = spawn(process.execPath, [tsx, '--test', ...process.argv.slice(2)], { stdio: 'inherit', env: isolatedEnvironment({ ...testInputs(), [PYTHON_VARIABLE]: python }, tools) });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
