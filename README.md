# mcp-relay

The Model Context Protocol front end of the VM relay, packaged as a Claude Code
plugin and as a pi package. [pi-vm-relay](https://github.com/WeZZard/pi-vm-relay),
which gave pi a native `relay` tool directly, is retired; mcp-relay replaces
it for both Claude Code and pi, the latter loaded through `pi-mcp-adapter`. It
is an MCP server: nineteen `relay_*` tools, each with its own schema, title
and annotations, and the server's `instructions`. The user command, status,
ships as one small command file per host (see "Commands"). There is no skill and no hook. Together they offer recorded,
snapshot-evidenced computer-use, browser-use and code runs in a fresh,
dedicated VM, for any work the agent chooses to run there. Nothing here executes local computer-use, spawns
subagents, targets physical machines, records video, or attaches to existing
browsers.

The project was named mcp-vm-relay before v0.12.0. The npm package is now
`@wezzard/mcp-relay`, the plugin and its marketplace are `mcp-relay`, and every
`MCP_VM_RELAY_*` variable is now `MCP_RELAY_*`; the old names are not read. The
default state directory moved with the name, so finish or release a lease the
old relay owns before upgrading.

## How it is built

The relay implementation lives in this repository: the manager
(`src/manager.ts`), the vm-service client, the registry with its OS-level lock,
the guest transfer and transport, the evidence package and its state merge, the
selected-environment profile, the console and saved-image contracts, the strict
tool contract (`src/schema.ts`), the action dispatch and bounded result
rendering (`src/surface.ts`), and the two guest programs
(`src/guest/receiver.ts`, `src/guest/mcp-host.ts`). It was inherited from
[pi-vm-relay](https://github.com/WeZZard/pi-vm-relay) at commit 8990123,
synchronized with its implementation through commit 0d69fc7 before that
project's retirement, and is maintained here as mcp-relay's own
implementation from then on. `src/server.ts` binds the core to MCP over
standard input and output.

The committed `dist/` holds `server.mjs` (the MCP server with the core bundled
in), the guest bundles the manager stages (`receiver.mjs`, `mcp-host.mjs`) and
the doctor. Compiled [relay-driver](https://github.com/WeZZard/relay-driver)
code, the recorded-execution and evidence substrate, is bundled with hashes and
provenance in `dist/build-info.json`. Consumers load `dist/`; no build, SDK
checkout or network fetch happens at install time.

The Claude Code plugin and pi both reach this same server as plain MCP: pi
through `pi-mcp-adapter` (see "Use with pi" below), Claude Code by starting it
directly. Every tool's identity, schema and contract are shared; the plugin
adds nothing Claude-Code-specific beyond the marketplace packaging and the
`vm-relay-operator` agent definition.

| In pi-vm-relay (retired, native pi extension) | Here (MCP server) |
|---|---|
| a registered `relay` tool with thirteen actions | nineteen `relay_*` MCP tools from the server `relay`, each with its own schema, title and annotations |
| doctrine injected before each agent turn | the server's MCP `instructions`, plus a compact version in the `relay_probe` and `relay_acquire` descriptions for clients that do not surface `instructions` |
| `/relay-status` command | `/mcp-relay-status` in pi, `/mcp-relay:status` in Claude Code; it asks the assistant to call `relay_status` |
| prompt-composed guest operator | the `vm-relay-operator` agent definition (Claude Code only), limited to the relay's tools and read-only file tools |
| typed image blocks in a run result, with pi's `tool_result` hook keeping the error flag | MCP image content blocks in the tool result, with the MCP `isError` flag set beside them |
| session shutdown pauses lease renewal | the same when the server's stdio closes or it is signalled: renewal pauses after one final renewal for the rest of the lease's TTL, the recording detaches, the VM is retained until that TTL for an explicit `relay_finish` or `relay_release`, and the vm-service TTL is the backstop |
| the settled agent pauses renewal | none: MCP has no such hook, so the instructions and each run tool's description say "finish or release before you return" |

## Install

### Use with Claude Code

Try it from a checkout:

```sh
claude --plugin-dir /path/to/mcp-relay
```

Or add this repository as a marketplace and install the plugin from it:

```
/plugin marketplace add WeZZard/mcp-relay
/plugin install mcp-relay@mcp-relay
```

Once loaded, the model sees the nineteen tools as
`mcp__plugin_mcp-relay_relay__relay_search`,
`mcp__plugin_mcp-relay_relay__relay_probe`, and so on through
`mcp__plugin_mcp-relay_relay__relay_status` (see "The tools" below for
the full table). The `vm-relay-operator` agent definition allows them by those
names. The server can also be configured directly in a project's `.mcp.json`
with `node /path/to/mcp-relay/dist/server.mjs`, in which case the tools are
`mcp__relay__relay_search` and so on.

### Use with pi

```sh
pi install npm:@wezzard/mcp-relay
```

This needs `pi-mcp-adapter` installed. The tools appear as `relay_search`,
`relay_probe`, and so on through `relay_status`, with no host-specific
prefix (`pi-mcp.json` sets `toolPrefix: "none"`). The package also
ships a pi prompt template for the command, `/mcp-relay-status`.

### Use with npx

```sh
npx -y @wezzard/mcp-relay
```

This runs the MCP server directly on stdio, for a client that speaks MCP
without a Claude Code plugin or pi package wrapper.

### Prerequisites

Node 22+, Python 3 with `fcntl` for the registry lock, and for VM execution an
Apple-silicon Mac with Tart, a running
[vm-service](https://github.com/WeZZard/vm-service) and prepared guest images.
Check readiness with `node dist/doctor.mjs`. It does not acquire a VM or
establish guest UI readiness. Staging and runs assume no software in the guest
but Node.js, which runs the relay's own guest code; `relay_stage` refuses an
image without it. A run takes before and after snapshots only when the image
lists capture software, cua-driver (catalog ids `bundle:com.trycua.driver` and
`dpkg:cua-driver`); otherwise its record has no snapshots, and that is not a
gap. Snapshots and the `cua` target need cua-driver with capture and input
permissions; on Linux, native X11 and `serve --no-overlay`.
The `playwright` and `chrome-devtools` targets of `relay_run` need a browser in
the guest (installed Google Chrome, or a path given as `browserExecutable`);
their pinned servers are downloaded once on the host and staged, so the guest
needs no network or npm. Console viewing needs the vm-service guest-sharing backend and its
guest preparation; see `docs/console.md` here.

## The tools

Each tool's `inputSchema` is a plain object with no root `anyOf`/`oneOf`/`allOf`
and no `action` field, derived directly from the strict per-action contract in
`src/schema.ts` (nested unions inside a property, such as `relay_image`'s
`target`, are unaffected). A call is mapped back to that contract's shape and
dispatched exactly as the retired single `relay` tool was, so behaviour,
results, image blocks and `isError` semantics are unchanged from before this
split. `relay_run` forwards the cua-driver, Playwright MCP and Chrome DevTools
MCP tool calls a model already knows; `relay_exec`, `relay_script` and
`relay_code` share the optional `reason`, `step`, `snapshots` and `timeoutMs`.
Evidence is automatic for all four: see "relay_run" below.

| Tool | Title | Replaces (`action`, `kind`) | Purpose |
|---|---|---|---|
| `relay_search` | Search installed applications | `search` | Find installed applications from image inventories by name and optional OS. |
| `relay_probe` | Probe host and guest readiness | `probe` | Default `scope: "host"` reports host facts, service availability and every guest the session holds, with its state. `scope: "guest"` with `guest` checks Node.js, which staging requires, and reports as facts the cua-driver executable, each `relay_run` target's availability and whether runs take snapshots, on that guest, without installing, starting or claiming capture readiness. |
| `relay_acquisition_capabilities` | Read acquisition capabilities | `acquisition-capabilities` | Read versioned acquisition options (VNC backends) without allocation or ownership recovery. |
| `relay_acquire` | Acquire a VM | `acquire` | Register the task, acquire a fresh VM, a guest, on the network `MCP_RELAY_GUEST_NETWORK` names and start its heartbeat; declare outputs before work. Answers `guest`, the guest's name in the session, which every later call on it names. Optional `vnc` prepares sharing without opening a viewer. |
| `relay_stage` | Stage the guest runtime | `stage` | Push and hash-check the runtime, support files and an opt-in workspace, all from the project folder. Needs only Node.js in the guest, and reports whether runs take snapshots (only when the image lists cua-driver); `browserExecutable` names the guest browser for the browser targets. Failed staging can be retried; a staged runtime accepts corrected executable paths; `resetRecording: true` archives the recording and starts a new one on the same VM. |
| `relay_exec` | Run a guest command | `run`, `exec` | One recorded guest command. `diagnostic: true` records command diagnosis or repair without screenshot evidence, including before staging. |
| `relay_script` | Run a guest script | `run`, `script` | One recorded guest script file (`localPath`, in the project folder, and `language`). |
| `relay_code` | Run guest code | `run`, `code` | One recorded inline guest code snippet (`code`, `language`). |
| `relay_run` | Run an MCP tool call in the VM | `run`, `mcp` | One recorded tool call (`target`: `cua`, `playwright` or `chrome-devtools`; that server's own `tool` and `args`), forwarded unchanged to the server inside the VM. Replaces `relay_cua` and `relay_browser`. |
| `relay_tools` | List a target's tools | `tools` | The target's real `tools/list` from its in-guest server: names, descriptions and input schemas; `tool` narrows to one. |
| `relay_image` | Retrieve a saved image | `image` | Retrieve one saved display image, declared application image or immutable image reference without input, capture, directory export or acquisition. |
| `relay_extract` | Extract declared outputs | `extract` | Pull only declared files or directories with source and host checksum verification. |
| `relay_finish` | Finish and deliver evidence | `finish` | Extract the guest's declared outputs, deliver and verify its snapshot package, destroy its VM and unregister it; the session's other guests keep running. |
| `relay_release` | Release the VM | `release` | Retain the guest's available evidence and abandon or destroy its VM; the other guests keep running. When this session holds no guest, the result is an error that says nothing was released. |
| `relay_console_resolve` | Resolve console status | `console-resolve` | Resolve non-secret console status for the guest's lease and environment. |
| `relay_console_open` | Open console viewing | `console-open` | Open explicitly user-requested viewing on the service host, with `console_id`, `attempt_id`, `userRequested: true`, `reason` and `expected`. |
| `relay_console_cancel` | Cancel console viewing | `console-cancel` | Cancel the identified viewing attempt without releasing the VM. |
| `relay_status` | Show relay status | (unchanged) | Every guest this session holds, by name, each with its lease: backend binding, guest state, renewal state, console observation, last error, staging state and evidence path; plus `maxGuests`, the project directory, the VM service origin and the selected environment. `active` is false when no guest's lease is being renewed. |

`readOnlyHint`/`idempotentHint` are true for `relay_search`, `relay_probe`,
`relay_acquisition_capabilities`, `relay_console_resolve`, `relay_image` and
`relay_status`; `destructiveHint` is true only for `relay_finish` and
`relay_release`, which destroy a guest's VM; `openWorldHint` is true only for the
four run tools, whose guest code may reach the network.

A run's result carries the execution identity and outcome, the derived step
record, and, when the snapshot plan captured the after phase and delivery
succeeded, the saved after-image as an MCP image content block. A command's
result also carries the guest's bounded standard output and error; a
`relay_run` result carries the target tool's own text and image blocks. The
full receipt stays in the evidence package.

## Commands

The command asks the assistant to call one relay tool and report the answer.
It changes nothing itself.

| Command in pi | Command in Claude Code | Arguments | Purpose |
|---|---|---|---|
| `/mcp-relay-status` | `/mcp-relay:status` | none | Calls `relay_status` and reports this session's guests and their leases as they are. Read-only. |

It is not an MCP prompt. pi's MCP adapter can only name a prompt
`/mcp__<package>__<server>__<prompt>`, so each host gets its own command file
instead: pi prompt templates in `pi-prompts/` (listed in `package.json` under
`pi.prompts`) and Claude Code plugin commands in `commands/`. Both are
generated by `npm run build` from `scripts/host-commands.mjs`; do not edit them
by hand. CI and the release workflow check the packed tarball with
`scripts/verify-package.mjs`: the generated files must match their source, pi's
glob must select exactly the one template, and the packed server must start
without the prompts capability. The release publishes and attaches the same
tarball it checked.

## Ownership, failure and recovery

- One server session holds several guests at once, up to `MCP_RELAY_MAX_GUESTS` (4 by default). `relay_acquire` names each guest, such as `login-test-1`, and every tool that acts on a guest takes that name as `guest`. Each guest keeps its own lease and heartbeat, its own evidence folder under `relay-evidence/`, its own background downloads, owner lock and registry row, and its own finish or release; finishing or releasing one leaves the others running. Calls on different guests run at the same time; calls on one guest keep their order. An acquisition beyond the limit is refused with the names of the guests held; the backend's own limits, such as two macOS VMs per host, still hold and their refusals pass through.
- An operation failure retains the VM so the agent can inspect, repair and submit a new operation. Failed and uncertain operations are never automatically replayed.
- Use `finish` to deliver evidence and release, or `release` to abandon explicitly. A declared output that was never produced is recorded as incomplete (`incompleteExtractions`) rather than failing `finish`. A failed delivery retains the VM; a release failure retains ownership until destruction is verified.
- When the session ends (the client closes the server's standard input, a write to its standard output fails, or it is signalled), the relay renews each guest's lease once for the rest of its TTL, then renewal pauses and the recording detaches; no VM is destroyed and is retained until its TTL for an explicit finish or release. A `finish` or `release` already in flight completes first, for up to the shutdown grace period; after that the operation is cancelled and renewal pauses without it. The backend TTL and grace period handle abandoned leases. Status reports the last confirmed expiration time.
- While the session is live, the relay tracks the lease's own deadline (its start plus `ttlHours`) and renews vm-service only 15 minutes ahead at a time, never past that deadline, and stops renewing at it. A client that crashes without ending its session therefore leaves its VM leased for at most about 15 minutes, plus the backend's grace period, rather than its whole TTL.
- A restarted server with the same `MCP_RELAY_SESSION` reconciles each guest's durable ownership and reattaches its recording session without replaying prior work; every guest keeps its name. A session state written by a relay before several guests is restored as one guest named from its task. Context compaction does not reset VM state; `probe` reports the owned state without relying on earlier messages.
- A run tool's `timeoutMs` defaults to 120,000 ms and accepts integers up to 3,600,000 ms. It bounds command execution, not the snapshot delay or the lease lifetime. A timeout reports confirmed termination or uncertainty and keeps the VM available.
- `relay_exec` with `diagnostic: true` records command diagnosis or repair without screenshots, for explicitly requested diagnosis when capture is unavailable. Before staging it runs through vm-service in the guest's default directory; after staging in the recording workspace. It cannot join a snapshot group and is not visual verification.
- After diagnosing damaged recording state, `relay_stage` with `resetRecording: true` archives the old recording and starts a new recording session in the same VM. An existing receiver lock refuses the reset until its operation is reconciled. Prior evidence paths remain in the owned status.

## relay_run: MCP tool calls in the VM

`relay_run` takes the same tool calls a model already sends to cua-driver,
Playwright MCP or Chrome DevTools MCP and runs them against that server inside
the VM:

```json
{"target":"playwright","tool":"browser_navigate","args":{"url":"https://example.com"}}
{"target":"cua","tool":"click","args":{"pid":812,"window_id":3,"x":40,"y":90}}
{"target":"chrome-devtools","tool":"take_snapshot","args":{}}
```

`relay_tools {"target":"playwright"}` returns the server's real `tools/list`,
so the exact names and schemas are one call away. The arguments are checked
against the tool's input schema (a JSON Schema validator, Ajv) before anything
is sent; a mismatch is refused with the correct schema in the error.

- **Evidence is automatic.** Every call is admitted by the guest receiver,
  journaled, and bracketed by a before and an after display snapshot. The step
  record is derived from the call: the title is `<target>.<tool>` (for example
  `playwright.browser_click`), the expected result is "returns without a tool
  error", and cua-driver's accessibility forms are labelled `accessibility`.
  `reason`, `expected` and `afterIntervalMs` are optional overrides. The same
  rule now applies to `relay_exec`, `relay_script` and `relay_code`: their
  `reason`, `step` and `snapshots` are accepted but no longer required.
- **Default waits** before the after-snapshot: 300 ms for `playwright` and
  `chrome-devtools` (both servers already wait for the page to settle before
  they answer), 500 ms for `cua` and for commands.
- **Sessions persist.** A small guest-resident MCP host keeps one MCP SDK
  client per target, starting each server on first use, so a browser page or a
  native session survives between calls. `relay_finish` and `relay_release`
  stop it.
- **Results pass through.** The target's text blocks follow the relay's own
  result text, bounded like every result (50 KiB, 2000 lines); its images (up
  to four) are delivered inline under the usual image rules. Each call's full result, images and the servers'
  logs land in `workspace/relay-run`, the extraction `relay-run`, and come home
  with `relay_finish`.
- **Outcomes.** A call the relay proves was never sent is `refused`; a call
  that may have reached the server and has no answer (timeout, crash, a
  malformed answer) is `uncertain`, and the server is stopped so nothing it
  still holds can act later; the target's own `isError: true` is
  `completed-with-tool-error` (exit status 3). All three are error results and
  keep the VM. Nothing is ever replayed.

The launch commands, pinned versions and the full outcome mapping are in
`docs/relay-run.md`.

## Saved images

A run tool names its saved after-image whenever the snapshot plan captures that
phase: a standalone event or a text group's last event. The result does not
wait for the image. Its `imageDelivery` is `pending` with the image identity
(`imageId`, `originalPath`, hash and size). In the background, one download at
a time, the relay brings each step's evidence to the host as one archive: its
before- and after-images, its receiver and action records, and its `relay_run`
result file. `relay_finish` and `relay_release` wait only for the download in
flight. They put the steps still queued, and every other file the host lacks,
into one archive of their own, and copy the files the step downloads already
brought instead of pulling them again. `relay_status` counts the steps whose
download a lifecycle operation took over as `coalesced`. A first or intermediate
group event and a diagnostic command do not invent an image. Execution and
image delivery are independent outcomes: a pending image does not turn a
failed command into a successful one. The delivery identity leads the result
text so it survives truncation. The design is `docs/screenshot-delivery.md`
§10.

`relay_image` shows a saved image. Asked for an image whose download is still
queued or running, it waits for that download within its own deadline. It
retrieves the same saved image through one closed selector; it never repeats input, creates a capture, exports the
consumer directory or acquires a VM:

```json
{"target":{"source":"display","sessionId":"<recording-session>","executionId":"<saved-execution>","phase":"after"}}
{"target":{"source":"application","name":"relay-run","path":"playwright/<call>/image-1.png"}}
{"target":{"source":"reference","imageId":"image-<64 lowercase hex digits>"}}
```

- Display selection needs `before` or `after`; a phase the plan did not request returns `not-requested`. Application selection needs an acquisition-time declaration: a directory declaration takes one relative file path, a file declaration omits `path`. A reference resolves to the same original bytes or an explicit failure.
- Originals are limited to 64 MiB, 40,000,000 decoded pixels and 32,768 pixels per dimension; PNG, JPEG and WebP are accepted. The preview is at most 2,000 × 2,000 pixels and 4 MiB of base64. **Presentation differs from pi here:** pi resizes through its own image helper, while this core has no codec dependency. A PNG original is decoded and, when it exceeds the preview bounds, resampled in-process (area averaging, `node:zlib`); a JPEG or WebP original has its container validated and passes through unchanged when within bounds, and is reported `presentation-unavailable` otherwise. No EXIF orientation is applied; dimensions are those stored. The presentation receipt records the policy, the original and preview dimensions, the MIME type, hash, size and whether bytes were transformed, beside the untouched original.
- Each delivery has a 90-second deadline and a shared budget of three byte-transfer attempts. Only transient transfer failures are retried; authorization, unsafe-path, capture, format and integrity failures are not. Recommend at most two explicit recovery calls for the same reference; if a required image still cannot be inspected, stop exploratory input and finish or release.
- Immutable catalog entries bind each reference to the owner, enclosure, backend and original identity. A closed or sealed guest returns `stale-reference`; delivered originals remain readable with the host's file tools. Finalization materializes verified originals at canonical snapshot paths and preserves prior state when merging guest evidence.
- Attachment means the block was included in the result; it does not prove the model inspected it or that a human reviewed it.

## Live console viewing

Acquisition never opens a viewer. `relay_acquisition_capabilities` reads the
backend's VNC options; `relay_acquire` with `vnc: true` checks OS availability
and requires a ready console and lease identity in the response.
`relay_console_open` is permitted only following an explicit user request,
requires `userRequested: true`, `console_id`, `attempt_id`, `reason` and
`expected`, and opens on the declared service host, not on a remote client.
`relay_console_resolve` refreshes the non-secret observation;
`relay_console_cancel` closes managed viewing resources and never releases the
VM. Console status `ready` is guest preflight, not launch
success; transport connection, authentication, displayed pixels and human
confirmation are separate observations that console actions never establish.
On macOS the human must choose Standard sharing of the existing console, not a
new Log In session or a High Performance display; the relay never confirms
that selection, and `server_enforced_view_only: false` with `session_binding:
viewer-selection-unverified` remain limitations after transport connects.
Failed or uncertain launches retain ownership; resolve or cancel the attempt
rather than replaying it. Console tests use mocked backends; no live viewer,
installation or platform acceptance is claimed here.

## Selected environments

Set `VM_ENVIRONMENT_FILE` to a profile that binds a loopback vm-service
endpoint, an image repository, a Tart store and separate service, image and
relay state directories together. The profile is validated before use, is
authoritative over the individual `MCP_RELAY_*` variables, and an invalid
selection fails rather than falling back. Leases are bound to their backend and
store: an owned lease restored under a different environment fails before any
backend operation, and destruction is verified with the selected Tart binary
and `TART_HOME`. `docs/selected-environments.md` documents the schema. The
bundle the profile exports to subprocesses is the canonical one vm-service
defines, so its relay entries keep the `VM_RELAY_STATE_DIR` and
`VM_RELAY_URL` names and the three runtimes agree; this server reads its own
settings from the profile.

## Evidence and cleanup

Default output is `relay-evidence/<unique-task>/` under the project, with
`state/` (the guest journal, action records, receipts and snapshot PNGs),
`host/` (reasons, submissions, transfer facts, receipts, diagnostics, image
deliveries and lifecycle events), `extractions/` (declared files, including the
page captures), `manifest.json`, which checksums everything, and `OPENING.txt`.
The package is the raw evidence only; pi-secretary's computer-use extension
shows its steps and verdicts beside the agent's session. The steps and verdicts
are derived from the evidence when you review it, so an earlier package is reviewed with today's rules.
A program that reads relay packages gets the same derivation from
`@wezzard/mcp-relay/review-data`: `await reviewData(<directory>)` returns the
steps (with each snapshot's package path), the verdicts and their reasons. No network, VM or external assets are
needed. Diagnostic commands appear in the review data
as command-only steps without screenshots. `finish` verifies the package before
destroying the VM; a failed delivery removes only the derived files it created
and retains the VM for a corrected attempt. Cleanup checks the read-only host
Tart inventory (the selected one, when an environment is selected) before
claiming destruction. Leases default to 4 hours, renewed 15 minutes at a
time up to that TTL; the vm-service reaper is the final backstop for process death.

Relay evidence has no size limit (owner decision PS-D12): screenshots are
delivered as captured, never scaled, compressed, deduplicated or budgeted, and
the relay state is delivered whatever its total size or file count. Only what a
client stages into the guest is bounded (512 MiB and 10,000 files per staging
request), and a single image original must be at most 64 MiB to be valid. Before
`finish` pulls the relay state it checks that the evidence volume has room for
it; when it does not, `finish` fails before pulling, names the shortfall and
keeps the VM for a retry after space is freed.

## Configuration

- `MCP_RELAY_PROJECT`: the project directory (the plugin passes Claude Code's). Evidence lands under `relay-evidence/<task>/` there. Every host file the relay reads, `relay_stage`'s `workspace` and `files[].local` and `relay_script`'s `localPath`, lies in this folder: a relative path resolves against it, an absolute path must already lie in it, and a path through a symlink is refused.
- `MCP_RELAY_SESSION`: an explicit session identity. By default each server process takes a fresh random one; a stable identity lets a restarted server reconcile and reattach the guests of the same identity.
- `MCP_RELAY_URL`: the loopback vm-service origin, default `http://localhost:6240`. Non-loopback servers, redirects and physical targets are refused.
- `MCP_RELAY_GUEST_NETWORK`: the network every guest is acquired on, `nat` (the default) or `internet`. With `internet`, vm-service gives a guest that reaches the internet and reaches neither this host nor any private network; an application that hosts agents sets it. The agent cannot choose it: `relay_acquire` takes no network. Any other value stops the server at startup and refuses every acquisition, and a vm-service that cannot give `internet` refuses the acquisition with its own reason, never falling back to `nat`.
- `MCP_RELAY_MAX_GUESTS`: the most guests one session holds at once, a positive integer, default 4. Any other value stops the server at startup.
- `MCP_RELAY_STATE_DIR`: host state, otherwise `$XDG_STATE_HOME/mcp-relay` or `~/.local/state/mcp-relay`, one subdirectory per session, with one `guests/<guest>/` folder per guest holding its ownership record and owner lock.
- `MCP_RELAY_REGISTRY`: an explicit task registry file; otherwise an existing compatible `~/AGENTS.md` VM table, or a private managed `registry.md` in the state directory.
- `MCP_RELAY_SHUTDOWN_GRACE_MS`: how long a session end waits for an in-flight operation before cancelling it; default 120000.
- `MCP_RELAY_PYTHON`: the Python 3 used for the registry lock; default `python3` on PATH.
- `VM_ENVIRONMENT_FILE`: a selected environment profile; it overrides the URL, state directory and registry above and binds the Tart store.
- Guest files go to `/var/tmp/<UTC-timestamp>-mcp-relay-<task>/`, with the runtime in `receiver.mjs`, support in `support/` and work in `workspace/`.

## Development

Build relay-driver using its own instructions, then in this checkout:

```sh
npm ci
npm run setup:dev -- /absolute/path/to/built/relay-driver
npm run check                                            # build, typecheck, tests
```

Three tests need a sibling checkout beside this repository and skip with a
message when it is absent: the console fixture regeneration and the
environment parity test need `../vm-service`, and the shared catalog text
corpus needs `../pilot-images`. The JPEG and WebP presentation fixtures in
`tests/fixtures/` were encoded once from the test's spatial PNG with a codec
outside this repository and are committed, because the core carries none.

### End-to-end with headless Claude Code

```sh
npm run test:e2e
```

This runs `claude --print` with the plugin loaded from this checkout
(`--plugin-dir`), the model limited to the relay's tools, and the server pointed
at a loopback stand-in for vm-service (`tests/e2e/fixture-service.ts`), which
keeps leases as records, runs the relay's own Node and transfer commands
locally, and fakes the desktop capture driver. Four cases run, each a separate
headless session: the status call (which also proves the server is pointed at
the stand-in before anything is acquired), an invalid call refused by the
contract, a full acquire, stage, exec, finish lifecycle with a verified package,
and a lease abandoned when the session ends, which is retained with its renewal
paused rather than released. What is checked is what happened on disk and at
the service, not what the model said. The suite needs `claude` on PATH with an
account and spends a few model turns per case, so it is not part of `npm test`.

The relay-driver links are development-only. The tests run the manager, the
guest programs and the shipped server against fixture HTTP services, fixture
MCP servers built with the MCP SDK and a real MCP client over stdio; no VM, desktop or user
registry is touched. Commit the regenerated `dist/` with source changes.

## Releasing

Cut a release with:

```sh
node scripts/bump.mjs X.Y.Z && git push --follow-tags
```

`scripts/bump.mjs` sets `X.Y.Z` as the version in `package.json`,
`.claude-plugin/plugin.json` and the pinned `pi-mcp.json` arg, refreshes
`package-lock.json`, rebuilds `dist/`, commits `Release vX.Y.Z` and creates the
annotated tag `vX.Y.Z`. It refuses to run against a dirty working tree or a
malformed version, and it never pushes — `git push --follow-tags` is a
separate, explicit step.

Pushing the tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
rebuilds `vmctl`, checks the working build against a fresh one, and publishes
to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — no `NPM_TOKEN` secret involved), then creates the matching GitHub
release.

Trusted publishing has to be configured on npmjs.com, and npm requires the
package to already exist before you can do that. The **first** publish must
therefore be done by hand (`npm publish --access public` from a maintainer's
machine) before its trusted publisher can be configured for this workflow.

## License

MIT — see [LICENSE](LICENSE).
