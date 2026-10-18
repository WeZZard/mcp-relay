import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RelayManager } from './manager.js';
import { relayParameters, toolInputSchema, validateRelayInput, type RelayAction } from './schema.js';
import type { ImageResult } from './images.js';

/**
 * The relay's host-agnostic surface: the identity and model-facing text of
 * every tool but relay_status, the action dispatch and the bounded result
 * rendering. The MCP server (`src/server.ts`) wraps exactly this and adds
 * relay_status, so every MCP client (Claude Code, pi through pi-mcp-adapter,
 * or a bare MCP client) sees the same fourteen tools with the same schemas,
 * results and error semantics.
 */
export interface RelayToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface RelayTool { name: string; title: string; description: string; annotations: RelayToolAnnotations; action: RelayAction }

/** Read-only tools: they never change the VM, and calling one again changes nothing new. */
const readOnly: RelayToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** A tool that acts on the VM. `destructive` is true only for the two tools that destroy it; `openWorld` is true only for the tools that run guest code, which may reach the network. */
const acts = (openWorld: boolean, destructive = false): RelayToolAnnotations => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: openWorld });

export const relayTools: readonly RelayTool[] = [
  {
    name: 'relay_search', action: 'search', title: 'Search installed applications', annotations: readOnly,
    description: 'Find an installed application in the image inventories by name, then choose an image yourself; optional before relay_acquire. Matches canonical names and aliases by exact, prefix and substring comparison, with an optional hard `os` filter (`linux`/`macos`). Returns each match\'s installed versions (which may be null), image keys, OS and architecture; a truncated result means whole installations were omitted, and an empty result is distinct from a catalog error. Never allocates, boots, installs, reserves capacity or chooses an image for you.',
  },
  {
    name: 'relay_probe', action: 'probe', title: 'Probe host and guest readiness', annotations: readOnly,
    description: 'Read-only host and service facts, used to pick an image; it reports current owned state on its own, so call it again after context compaction rather than trusting earlier messages. Default `scope: "host"` reports host permissions and activity, VM service availability, and every guest this session holds with its state, not guest readiness. `scope: "guest"` with `guest` (an already-acquired guest) reports whether Node.js, which staging requires, is available, and, as facts, whether each relay_script language\'s runtime runs (`/bin/sh`, `node`, `tsx`, `python3`), the software the image lists in the catalog, and whether this lease\'s runs take snapshots, without installing or starting anything, and never claims capture readiness. Acquire one guest for each machine the work needs; several may run at once. Continue each guest in order: relay_acquire, relay_stage, relay_script, relay_image/relay_extract, then relay_finish or relay_release, called explicitly for every guest before you return.',
  },
  {
    name: 'relay_acquisition_capabilities', action: 'acquisition-capabilities', title: 'Read acquisition capabilities', annotations: readOnly,
    description: 'Read the backend\'s versioned VNC console options for the images it serves. Read-only: it neither acquires a VM nor recovers ownership of one.',
  },
  {
    name: 'relay_acquire', action: 'acquire', title: 'Acquire a VM', annotations: acts(false),
    description: 'Acquire one fresh VM, a guest, and start its ownership heartbeat. The result\'s `guest` is the guest\'s name in this session, such as `login-test-1`; every later call on this guest names it with `guest`. Requires `task` (a short slug), `image` (a key from relay_probe or relay_search) and `extractions`: every output you intend to bring home, declared before any work (`[]` is allowed; nothing is extracted automatically). Optional `ttlHours` (default 4), `env` (a credential pack, never baked into images), `fullWorkspace` (opt in to deliver the whole workspace) and `vnc` (default false; only prepares console-sharing capacity, never opens a viewer). Acquire one guest for each machine the work needs: several guests may run at once, each with its own lease, evidence and finish, up to the session\'s limit (relay_status reports `maxGuests`, MCP_RELAY_MAX_GUESTS, default 4); an acquisition beyond it is refused with the names of the guests held. When the host is at capacity, such as at its limit on running macOS VMs, the acquisition waits for it, asking again every 15 s for up to MCP_RELAY_CAPACITY_WAIT (30 minutes by default), and the result\'s `waitedForCapacityMs` says how long it waited; once the wait runs out it is refused with the backend\'s reason and the time waited. The backend\'s other refusals pass through at once. Continue with relay_stage, relay_script, relay_image/relay_extract, then relay_finish or relay_release explicitly before you return; a failed step keeps the VM for repair rather than replaying uncertain input.',
  },
  {
    name: 'relay_stage', action: 'stage', title: 'Stage the guest runtime', annotations: acts(false),
    description: 'Push and hash-check the guest runtime, plus an optional workspace and support files (`files`, landing under `support/`), onto the acquired guest that `guest` names. `workspace` and each `files[].local` lie in the project folder, relative to it or absolute inside it, with no symlinks. Staging needs only Node.js in the guest (`nodePath`, default `node`); an image without it is refused, because the relay pushes no runtime. Runs take before and after snapshots only when the image lists capture software (cua-driver); otherwise their records have none, and the result\'s `snapshots` says which. When the image lists cua-driver, staging waits up to 120 s for it to take a screenshot, since the image starts its daemon at login, and refuses if it never does. `cuaDriver` names the guest cua-driver the snapshots use. A failed stage can be retried; once staged, only corrected executable paths may be resubmitted, and staging does not prove capture readiness. `resetRecording: true` archives the current recording\'s evidence and starts a fresh recording on the same VM; it refuses while a receiver lock is held.',
  },
  {
    name: 'relay_script', action: 'run', title: 'Run a guest script', annotations: acts(true),
    description: 'Run one guest script as one recorded operation; never hide several interactions in one call. A command is a shell script. The script drives whatever the image lists, such as cua-driver, Playwright or Chrome DevTools, through their own libraries or command lines, and its exit status says whether it succeeded, so a script that calls cua-driver checks the driver\'s answer itself. Requires `language` (`shell`, `javascript`, `typescript` or `python`) and `inline`: with `inline: true` give the script itself as `code` (up to 1 MiB); with `inline: false` give `localPath`, a host file in the project folder (relative to it or absolute inside it, with no symlinks). Give exactly the one `inline` names; any other call is refused. It runs in the staged workspace: shell with `/bin/sh`, JavaScript with the guest\'s Node.js, TypeScript with `tsx` from the guest\'s PATH or else the guest Node.js\'s own type stripping (22.6 or later), and Python with `python3` from the guest\'s PATH (relay_probe scope=guest reports which run); a missing runtime refuses the run before it starts. Evidence is automatic: the relay records a step derived from the call and, when the image lists cua-driver, snapshots the display before and after. Optional `reason` (intent, never authorization), `step` (`id`, `title`, `expected`, `inputMode`) and `snapshots.afterIntervalMs` (default 500 ms) enrich or tune the record; consecutive keystrokes may form an explicit text group with `snapshots.group` (`first`/`member`/`last`). `timeoutMs` bounds execution (default 120000, up to 3600000). The result carries the outcome and bounded stdout/stderr; it names the after-snapshot as `pending` with its `imageId` while the image downloads in the background, so call relay_image with that `imageId` to see it. A refused, uncertain or nonzero result keeps the VM; never replay input whose effect is uncertain. `diagnostic: true`, for shell scripts only, records a diagnosis or repair without snapshots, even before relay_stage, running the script as `/bin/sh -c`; it is never visual verification, and its result has one `output` field with stdout and stderr combined.',
  },
  {
    name: 'relay_image', action: 'image', title: 'Retrieve a saved image', annotations: readOnly,
    description: 'Retrieve one already-saved image; never a new capture, input or directory export, and it never acquires a VM. `target` selects a display phase (`sessionId`/`executionId`/`phase`: `before`/`after`), a declared application file (`name`, plus a relative `path` for a directory declaration), or an immutable `reference` (`imageId`). PNG, JPEG and WebP only; originals up to 64 MiB and 40,000,000 decoded pixels; the delivered preview is at most 2000x2000 px and 4 MiB of base64 (PNG originals are resampled in-process; JPEG/WebP pass through only within bounds). Each delivery has a 90-second deadline and up to three transfer attempts. A run\'s after-snapshot is `pending` in its result; retrieve it here with its `imageId` or display selector, which waits for its background download within the same deadline. If an image did not arrive, recover it here the same way, never by repeating the input or capturing again, and stop after at most two such recovery calls if it still cannot be inspected. A closed guest returns `stale-reference` for a display or reference target; its delivered originals stay readable with host file tools. An attached image proves only that the block was included, not that anyone inspected or reviewed it.',
  },
  {
    name: 'relay_extract', action: 'extract', title: 'Extract declared outputs', annotations: acts(false),
    description: 'Pull one or more already-declared extraction outputs home early, by `names`. Only outputs declared on relay_acquire may be pulled; each pull verifies source and host hashes and rejects path traversal, symlinks, or a source that changed underneath it.',
  },
  {
    name: 'relay_finish', action: 'finish', title: 'Finish and deliver evidence', annotations: acts(false, true),
    description: 'Complete one guest\'s work: extract every declared output, deliver and verify a portable evidence package, then destroy the guest\'s VM and unregister it; the session\'s other guests keep running. The result reports delivery, snapshot completeness, execution outcome and human review as separate facts; a verified package is not a passing test, and a delivered package is not itself human approval. Call this, or relay_release, explicitly for every guest before you return, since ending the session does not do it for you. A declared output that was never produced is listed in `incompleteExtractions` and does not stop the delivery; any other failed extraction or delivery keeps the VM for a corrected attempt.',
  },
  {
    name: 'relay_release', action: 'release', title: 'Release the VM', annotations: acts(false, true),
    description: 'Abandon one guest\'s work: destroy the VM of the guest that `guest` names and unregister it, retaining whatever evidence already exists, without claiming the task succeeded; the session\'s other guests keep running. Use this instead of relay_finish when the task is not being completed. Safe to retry if a previous release attempt failed; a failed release keeps ownership until destruction is verified. When this session holds no guest, the result is an error saying that nothing was released; a lease acquired under another session identity is never guessed at.',
  },
  {
    name: 'relay_console_resolve', action: 'console-resolve', title: 'Resolve console status', annotations: readOnly,
    description: 'Refresh this session\'s non-secret console-viewing status for the lease of the guest that `guest` names. Read-only, and it never recovers ownership. A `ready` status means guest preflight only, not that a viewer launched: console operations carry no screenshots and never establish authentication, displayed pixels or a human\'s confirmation. On macOS, viewing requires the human to choose Standard sharing of the existing console, not a new Log In session or a High Performance display, and the relay never auto-confirms that choice; `server_enforced_view_only: false` and an unverified viewer selection remain limitations even once transport connects. Never replay an uncertain attempt: resolve it here, or close it with relay_console_cancel.',
  },
  {
    name: 'relay_console_open', action: 'console-open', title: 'Open console viewing', annotations: acts(false),
    description: 'Open console viewing for the lease of the guest that `guest` names, only following an explicit user request to watch. Requires `console_id` and `attempt_id` from relay_console_resolve, `userRequested: true`, `reason` (intent) and `expected` (what the human should expect to see); it opens on the declared service host, never a remote client, and is never triggered automatically by relay_acquire\'s `vnc` option. See relay_console_resolve for what a `ready` status does and does not prove. A failed or uncertain open keeps the attempt: resolve or cancel it rather than opening again with a new attempt.',
  },
  {
    name: 'relay_console_cancel', action: 'console-cancel', title: 'Cancel console viewing', annotations: acts(false),
    description: 'Cancel an open or uncertain console-viewing attempt by `console_id` and `attempt_id`. Closes managed viewing resources only; it never releases or destroys the VM.',
  },
];

/** A tool's own input schema, derived fresh from the strict contract branch its `action` selects. */
export function relayToolInputSchema(tool: RelayTool): Record<string, unknown> {
  return toolInputSchema(tool.action);
}

/** Map one MCP call's tool name and arguments back to the strict contract's action shape, e.g. `relay_script` args become `{ action: 'run', ...args }`, then dispatched through `relayCall` exactly as the retired single `relay` tool was. */
export function relayToolInput(name: string, args: Record<string, unknown>): unknown {
  const tool = relayTools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Unknown relay tool: ${name}`);
  return { action: tool.action, ...args };
}

/** The tool's input schema as plain JSON (TypeBox symbol keys dropped), for front ends that hand JSON Schema to a runtime. */
export function relayJsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(relayParameters)) as Record<string, unknown>;
}

export interface RelayRendered { text: string; details: unknown; resultPath?: string }
/** A typed image block for the runtime's tool result: base64 bytes without a data-URL prefix. */
export interface RelayImageContent { type: 'image'; data: string; mimeType: string }
export interface RelayCallResult extends RelayRendered {
  isError: boolean;
  /** For an image-bearing result: the delivery outcome and identity, kept beside the text so truncation never hides them. */
  imageDelivery?: Omit<ImageResult, 'content'>;
  /** The delivered image, when the delivery attached one. */
  image?: RelayImageContent;
}
/** The details kind of an image-bearing result; a front end may use it to tell such results apart. */
export const relayResultKind = 'relay-image-result-v1';

/** Text output is capped at 50 KiB / 2000 lines; a larger result is retained whole in a private local file. */
export async function renderRelayResult(value: unknown, resultRoot = join(tmpdir(), 'mcp-relay-results'), indent: number | undefined = 2): Promise<RelayRendered> {
  const full = JSON.stringify(value, null, indent);
  const text = new TextDecoder().decode(Buffer.from(full.split('\n').slice(0, 2000).join('\n')).subarray(0, 50 * 1024), { stream: true });
  if (text !== full) {
    await mkdir(resultRoot, { recursive: true, mode: 0o700 });
    const path = join(resultRoot, `${randomUUID()}.json`); await writeFile(path, full, { mode: 0o600 });
    return { text: `${text}\n[Truncated. Full result: ${path}]`, details: { resultPath: path }, resultPath: path };
  }
  return { text, details: value };
}

/**
 * An image-bearing result: the delivery identity leads the text (so it stays
 * model-visible even when command output exceeds the text bound), the rendered
 * result follows, and the image rides as its own block. Execution failure and
 * delivery failure both make the result an error without discarding the image.
 */
async function imageResult(value: Record<string, unknown>, delivery: ImageResult, executionFailed = false): Promise<RelayCallResult> {
  const { content: image, ...imageDelivery } = delivery;
  const { imageDelivery: _, ...rest } = value;
  const rendered = await renderRelayResult(rest);
  const failed = executionFailed || !['attached', 'pending', 'not-requested'].includes(delivery.status);
  return {
    text: `${JSON.stringify({ imageDelivery, executionFailed })}\n${rendered.text}`,
    details: { kind: relayResultKind, isError: failed, result: rendered.details, imageDelivery },
    ...(rendered.resultPath ? { resultPath: rendered.resultPath } : {}),
    isError: failed, imageDelivery, ...(image ? { image } : {}),
  };
}

/**
 * One relay call: validate the raw input against the strict contract (even
 * when the runtime validated already), dispatch to the manager, render the
 * result. A run whose execution was refused, uncertain or exited nonzero is
 * an error result, as is a run or image whose delivery failed; the front end
 * decides how its runtime signals that. The manager may be given as a getter
 * so that an invalid call creates nothing.
 */
export async function relayCall(host: RelayManager | (() => RelayManager), raw: unknown, options: { signal?: AbortSignal; toolCallId?: string } = {}): Promise<RelayCallResult> {
  validateRelayInput(raw); // Invalid input never obtains a manager: a getter is only called past this point.
  const manager = typeof host === 'function' ? host() : host;
  const { signal, toolCallId } = options;
  let value: unknown;
  switch (raw.action) {
    case 'acquisition-capabilities': value = await manager.acquisitionCapabilities(signal); break;
    case 'console-resolve': value = await manager.consoleResolve(signal, raw.guest); break;
    case 'console-open': value = await manager.consoleOpen(raw, signal); break;
    case 'console-cancel': value = await manager.consoleCancel(raw, signal); break;
    case 'search': value = await manager.search({ name: raw.name, os: raw.os }, signal, toolCallId); break;
    case 'probe': value = await manager.probe(raw.scope, raw.guest); break;
    case 'acquire': {
      const { action: _, ...input } = raw;
      value = await manager.acquire(input, signal); break;
    }
    case 'stage': {
      const { action: _, ...input } = raw;
      value = await manager.stage(input, signal); break;
    }
    case 'run': {
      const { action: _, reason: because, ...input } = raw;
      const execution = await manager.run({ ...input, ...(because === undefined ? {} : { because }) }, signal);
      const failed = execution.outcome.kind !== 'completed' || execution.outcome.exitStatus.code !== 0 || !!execution.outcome.exitStatus.signal;
      if ('imageDelivery' in execution) return imageResult(execution, execution.imageDelivery, failed);
      const rendered = await renderRelayResult(execution);
      return { ...rendered, isError: failed };
    }
    case 'image': return imageResult({}, await manager.image(raw.target, signal, raw.guest));
    case 'extract': value = await manager.extract(raw.names, signal, raw.guest); break;
    case 'finish': value = await manager.finish(signal, raw.guest); break;
    case 'release': {
      // Releasing nothing is an error result, so it never reads as a completed release.
      const released = await manager.release(raw.guest);
      return { ...(await renderRelayResult(released)), isError: 'ownedLease' in released && released.ownedLease === false };
    }
  }
  return { ...(await renderRelayResult(value)), isError: false };
}
