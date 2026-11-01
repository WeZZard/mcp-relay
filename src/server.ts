/**
 * mcp-relay: the Model Context Protocol front end of the VM relay.
 *
 * Everything the relay does lives in mcp-relay's host-agnostic core (the
 * manager, the machine-service client, the registry, the strict contract, the
 * action dispatch and the bounded result rendering). This file binds that
 * core to MCP over standard input and output: fourteen `relay_*` tools, each
 * with its own schema, title and annotations. The user command (status) is not
 * an MCP prompt: pi's adapter can only name those
 * `/mcp__<package>__<server>__<prompt>`, so each host gets its own command file
 * instead, generated from scripts/host-commands.mjs. There is no skill and no
 * hook.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RelayManager, Registry, guestNetwork, maxGuests, onExit, capacityWait, instructions, relayCall, relayToolInput, relayToolInputSchema, relayTools, selectedEnvironment, type RelayCallResult, type RelayToolAnnotations } from './core.js';

export const SERVER_NAME = 'relay';
/** The build injects this from package.json (esbuild define); under tsx it falls back to reading the file directly. */
declare const __MCP_RELAY_VERSION__: string;
export const SERVER_VERSION = typeof __MCP_RELAY_VERSION__ !== 'undefined' ? __MCP_RELAY_VERSION__
  : (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
export const STATUS_TOOL = 'relay_status';
/** How the plugin's MCP server names its tools once Claude Code scopes them. */
export const PLUGIN_TOOL_PREFIX = 'mcp__plugin_mcp-relay_relay__';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], isError });
/** A relay result as MCP content: the relay's text, then a delivered image as its own typed block when there is one. */
export function relayContent(result: RelayCallResult) {
  return { content: [{ type: 'text' as const, text: result.text }, ...(result.image ? [{ type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType }] : [])], isError: result.isError };
}

/** The project directory: the plugin passes Claude Code's; an unexpanded placeholder or nothing means the server's own working directory. */
export function projectDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const given = env.MCP_RELAY_PROJECT;
  return given && !given.includes('${') ? resolve(given) : cwd;
}

const readOnlyStatus: RelayToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const statusToolDefinition = {
  name: STATUS_TOOL,
  title: 'Show relay status',
  description: 'List every guest this session holds, by the name relay_acquire answered, each with its VM lease (backend binding, guest state, renewal, console observation, last error), staging state and evidence path, plus the most guests the session may hold (`maxGuests`), the project directory, the VM service origin and the selected environment in use; active:false when no guest\'s lease is being renewed. Read-only; it does not touch the VMs.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: readOnlyStatus,
};
/** Every MCP tool this server offers, for `tools/list` and `--schema`. */
export function allToolDefinitions() {
  return [
    ...relayTools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: relayToolInputSchema(tool), annotations: tool.annotations })),
    statusToolDefinition,
  ];
}

/**
 * How long shutdown waits for an in-flight operation (a finish or release the
 * client already sent) before it cancels the operation; override with
 * MCP_RELAY_SHUTDOWN_GRACE_MS. See docs/lifecycle-fixes.md.
 */
export const SHUTDOWN_GRACE_MS = 120000;
/** How long shutdown waits for a cancelled operation before it pauses renewal without it. */
export const SHUTDOWN_CANCEL_MS = 5000;
/** With MCP_RELAY_ON_EXIT=release, how long the last-resort direct release may take before the process exits anyway (DC-21). */
export const RELEASE_NOW_MS = 60000;
/** How often the server checks that the process that started it is still there (DC-21). */
export const PARENT_CHECK_MS = 2000;

export interface RelayServerOptions { sessionId?: string; project?: string; manager?: () => RelayManager; onExit?: 'pause' | 'release' }

export function createRelayServer(options: RelayServerOptions = {}) {
  const sessionId = options.sessionId ?? process.env.MCP_RELAY_SESSION ?? randomUUID();
  const exit = options.onExit ?? onExit();
  const project = options.project ?? projectDirectory();
  let manager: RelayManager | undefined;
  // A selected environment (VM_ENVIRONMENT_FILE) binds the backend, the image
  // store and the state directories together; it is resolved once, at the
  // first call, so an invalid selection is reported rather than falling back.
  // Tests inject options.manager directly instead of a real RelayManager.
  const get = options.manager ?? (() => {
    if (!manager) {
      const environment = selectedEnvironment();
      manager = new RelayManager({ sessionId, project, environment, registry: new Registry(environment ? { managedRoot: environment.profile.relayStateDir } : {}) });
    }
    return manager;
  });
  /**
   * The data relay_status reports, read-only. It reads the session's saved
   * guests first (host-only, no backend call), so a restarted relay reports the
   * guests it still owns before any other call.
   */
  const statusPayload = async () => {
    const environment = selectedEnvironment();
    const service = environment?.profile.vmServiceUrl ?? process.env.MCP_RELAY_URL ?? 'http://localhost:6240';
    const owned = get();
    return { ...(await owned.loadedStatus()), project, service, environment: environment?.identity };
  };
  // Cancels every in-flight tool call when shutdown gives up waiting for it.
  // Closing the transport would do the same at once, so shutdown never closes it first.
  const shutdownController = new AbortController();
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === STATUS_TOOL) return text(JSON.stringify(await statusPayload(), null, 2));
      if (relayTools.some(tool => tool.name === name)) return relayContent(await relayCall(get, relayToolInput(name, (args ?? {}) as Record<string, unknown>), { signal: AbortSignal.any([extra.signal, shutdownController.signal]), toolCallId: String(extra.requestId) }));
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) { return text(message(error), true); }
  });
  // Ending the session pauses lease renewal and detaches the recording; the VM
  // is retained for an explicit finish or release, and the backend TTL is the
  // safeguard for an abandoned one. With MCP_RELAY_ON_EXIT=release it releases
  // every guest the session holds instead, those an earlier process of the
  // session left included, so it loads the session even if no call did (DC-21).
  const cleanup = async (reason: string) => {
    try {
      if (exit === 'release') await (manager ?? get()).releaseAll(reason);
      else await manager?.cleanup(reason);
    } finally { manager = undefined; }
  };
  /** Cancel every in-flight tool call. */
  const cancel = (reason: string) => { shutdownController.abort(new Error(`Cancelled: ${reason}`)); };
  /** Pause renewal, or with MCP_RELAY_ON_EXIT=release release each guest directly, and release the owner locks without waiting for an in-flight operation; for shutdown only. */
  const pauseNow = async (reason: string) => { await (exit === 'release' ? manager?.releaseNow(reason) : manager?.pauseNow(reason)); };
  return { server, sessionId, project, onExit: exit, cleanup, cancel, pauseNow, status: () => manager ? manager.status() : { active: false, guests: [], maxGuests: maxGuests() } };
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--instructions')) { process.stdout.write(`${instructions}\n`); return; }
  if (args.includes('--schema')) { process.stdout.write(`${JSON.stringify(allToolDefinitions(), null, 2)}\n`); return; }
  if (args.length) throw new Error('Usage: server.mjs [--instructions | --schema]; with no argument the MCP server speaks on stdin/stdout');
  // A guest network the relay cannot honour refuses the server at startup (DC-17), as does a guest limit that is not a positive integer (DC-20) an exit behaviour other than pause or release (DC-21) and a capacity wait that is not whole seconds (DC-22).
  guestNetwork(); maxGuests(); onExit(); capacityWait();
  const relay = createRelayServer();
  const grace = Number(process.env.MCP_RELAY_SHUTDOWN_GRACE_MS ?? SHUTDOWN_GRACE_MS);
  if (!Number.isSafeInteger(grace) || grace < 0) throw new Error('MCP_RELAY_SHUTDOWN_GRACE_MS must be a nonnegative integer of milliseconds');
  const settledWithin = (work: Promise<unknown>, ms: number) => Promise.race([work.then(() => true), new Promise<boolean>(done => setTimeout(done, ms, false).unref())]);
  let closing: Promise<void> | undefined;
  // Every session end comes here once. Cleanup is queued behind an in-flight
  // operation, so a finish or release the client already sent completes first;
  // past the grace period the operation is cancelled, and if it still does not
  // settle, renewal is paused without it.
  const shutdown = (reason: string, code: number) => closing ??= (async () => {
    try {
      const cleanup = relay.cleanup(reason);
      if (await settledWithin(cleanup, grace)) return;
      process.stderr.write(`mcp-relay: an operation was still running ${grace} ms after the session ended; cancelling it\n`);
      relay.cancel(reason);
      if (await settledWithin(cleanup, SHUTDOWN_CANCEL_MS)) return;
      if (relay.onExit === 'release') {
        process.stderr.write('mcp-relay: the cancelled operation did not stop; releasing the guests without it\n');
        if (!await settledWithin(relay.pauseNow(reason), RELEASE_NOW_MS)) process.stderr.write('mcp-relay: releasing the guests did not end in time; exiting\n');
      } else {
        process.stderr.write('mcp-relay: the cancelled operation did not stop; pausing renewal without it\n');
        await relay.pauseNow(reason);
      }
    }
    catch (error) { process.stderr.write(`mcp-relay: cleanup failed: ${message(error)}\n`); code = 1; }
    finally { process.exit(code); }
  })();
  relay.server.onclose = () => { void shutdown('Relay session ended', 0); };
  // The SDK's stdio transport never reports end of file on standard input, so
  // a client that exits or closes its side would otherwise leave this process
  // renewing the lease for as long as the owner lock helper keeps it alive.
  process.stdin.once('end', () => { void shutdown('Relay session ended: the client closed standard input', 0); });
  process.stdin.once('close', () => { void shutdown('Relay session ended: the client closed standard input', 0); });
  // The SDK writes responses without an error handler. A write to a client
  // that has gone (EPIPE) would otherwise be an unhandled error that ends the
  // process before cleanup, leaving the lease recorded as active. Every later
  // error on the same stream lands here too.
  process.stdout.on('error', error => { void shutdown(`Enclosure session ended: standard output failed (${(error as NodeJS.ErrnoException).code ?? message(error)})`, 0); });
  process.once('SIGTERM', () => { void shutdown('Relay session terminated', 0); });
  process.once('SIGINT', () => { void shutdown('Relay session interrupted', 0); });
  process.once('SIGHUP', () => { void shutdown('Relay session hung up', 0); });
  // The process that started the relay can go away while standard input stays
  // open, such as when it passed its pipe on: the relay is then reparented, and
  // the session ends (DC-21).
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) void shutdown('Relay session ended: the process that started it went away', 0); }, PARENT_CHECK_MS).unref();
  await relay.server.connect(new StdioServerTransport());
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(new URL(import.meta.url)).catch(() => '')) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`mcp-relay: ${message(error)}\n`); process.exitCode = 1; });
}
