# mcp-relay

The Model Context Protocol front end of the VM relay, packaged as a Claude Code
plugin and as a pi package. [pi-vm-relay](https://github.com/WeZZard/pi-vm-relay),
which gave pi a native `relay` tool directly, is retired; mcp-relay replaces
it for both Claude Code and pi, the latter loaded through `pi-mcp-adapter`. It
is an MCP server: fourteen `relay_*` tools, each with its own schema, title
and annotations, and the server's `instructions`. The user command, status,
ships as one small command file per host (see "Commands"). There is no skill and no hook. Together they offer recorded,
snapshot-evidenced scripts, commands included as shell scripts, in a fresh, dedicated VM or on a
durable machine, a real Mac leased whole, for any work the agent chooses to run there; a script drives the desktop or a browser
through the software the image lists, such as cua-driver or Playwright. Nothing here executes local computer-use on the relay's own host, spawns
subagents, records video, or attaches to existing browsers.

The project was named mcp-vm-relay before v0.12.0. The npm package is now
`@wezzard/mcp-relay`, the plugin and its marketplace are `mcp-relay`, and every
`MCP_VM_RELAY_*` variable is now `MCP_RELAY_*`; the old names are not read. The
default state directory moved with the name, so finish or release a lease the
old relay owns before upgrading.

From v0.16.0 the relay's backend is machine-service, vm-service under its new
name. The relay asks for `/machines` paths, which vm-service never served, and
refuses a service whose `/health` does not answer `machine-service`. A selected
environment profile must be at `schemaVersion` 2 with `machctlPath`; a profile
at version 1 or with `vmctlPath` is refused with its fix in the error (DC-27).
The relay's own names do not change: `MCP_RELAY_*`, `VM_ENVIRONMENT_FILE`,
`VM_RELAY_*` and the state directories. Release every lease before switching,
as machine-service's installer requires.

## How it is built

The relay implementation lives in this repository: the manager
(`src/manager.ts`), the machine-service client, the registry with its OS-level lock,
the guest transfer and transport, the evidence package and its state merge, the
selected-environment profile, the console and saved-image contracts, the strict
tool contract (`src/schema.ts`), the action dispatch and bounded result
rendering (`src/surface.ts`), and the guest program, the receiver
(`src/guest/receiver.ts`). It was inherited from
[pi-vm-relay](https://github.com/WeZZard/pi-vm-relay) at commit 8990123,
synchronized with its implementation through commit 0d69fc7 before that
project's retirement, and is maintained here as mcp-relay's own
implementation from then on. `src/server.ts` binds the core to MCP over
standard input and output.

The committed `dist/` holds `server.mjs` (the MCP server with the core bundled
in), the guest bundle the manager stages (`receiver.mjs`) and the doctor. Compiled [relay-driver](https://github.com/WeZZard/relay-driver)
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
| a registered `relay` tool with thirteen actions | fourteen `relay_*` MCP tools from the server `relay`, each with its own schema, title and annotations |
| doctrine injected before each agent turn | the server's MCP `instructions`, plus a compact version in the `relay_probe` and `relay_acquire` descriptions for clients that do not surface `instructions` |
| `/relay-status` command | `/mcp-relay-status` in pi, `/mcp-relay:status` in Claude Code; it asks the assistant to call `relay_status` |
| prompt-composed guest operator | the `vm-relay-operator` agent definition (Claude Code only), limited to the relay's tools and read-only file tools |
| typed image blocks in a run result, with pi's `tool_result` hook keeping the error flag | MCP image content blocks in the tool result, with the MCP `isError` flag set beside them |
| session shutdown pauses lease renewal | the same when the server's stdio closes or it is signalled: renewal pauses after one final renewal for the rest of the lease's TTL, the recording detaches, the VM is retained until that TTL for an explicit `relay_finish` or `relay_release`, and the machine-service TTL is the backstop |
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

Once loaded, the model sees the fourteen tools as
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
[machine-service](https://github.com/WeZZard/vm-service) (formerly vm-service) and prepared guest images.
Check readiness with `node dist/doctor.mjs`. It does not acquire a VM or
establish guest UI readiness. Staging and runs assume no software in the guest
but Node.js, which runs the relay's own guest code; `relay_stage` refuses an
image without it. A run takes before and after snapshots only when the image
lists capture software, cua-driver (catalog ids `bundle:com.trycua.driver` and
`dpkg:cua-driver`); otherwise its record has no snapshots, and that is not a
gap. Snapshots need cua-driver with capture permission; on Linux, native X11
and `serve --no-overlay`. `relay_script` runs JavaScript with the guest's
Node.js, TypeScript with `tsx` and Python with `python3`, each from the guest's
`PATH`; the relay installs none of them, nor the software a script drives, such
as cua-driver, Playwright or a browser. Console viewing needs the machine-service guest-sharing backend and its
guest preparation; see `docs/console.md` here.

## The tools

Each tool's `inputSchema` is a plain object with no root `anyOf`/`oneOf`/`allOf`
and no `action` field, derived directly from the strict per-action contract in
`src/schema.ts` (nested unions inside a property, such as `relay_image`'s
`target`, are unaffected). A call is mapped back to that contract's shape and
dispatched exactly as the retired single `relay` tool was, so behaviour,
results, image blocks and `isError` semantics are unchanged from before this
split. One tool runs anything in a guest: `relay_script` runs a shell,
JavaScript, TypeScript or Python script, given inline or as a project file. A
command is a shell script. It takes the optional `reason`, `step`, `snapshots`,
`timeoutMs` and, for a shell script, `diagnostic`, and its evidence is
automatic: see "Runs" below.

| Tool | Title | Replaces (`action`) | Purpose |
|---|---|---|---|
| `relay_search` | Search installed applications | `search` | Find installed applications from image inventories by name and optional OS. |
| `relay_probe` | Probe host and guest readiness | `probe` | Default `scope: "host"` reports host facts, service availability and every guest the session holds, with its state. `scope: "guest"` with `guest` checks Node.js, which staging requires, and reports as facts whether each `relay_script` language's runtime runs (`/bin/sh`, `node`, `tsx`, `python3`), the software the image lists in the catalog and whether runs take snapshots, on that guest, without installing, starting or claiming capture readiness. |
| `relay_acquisition_capabilities` | Read acquisition capabilities | `acquisition-capabilities` | Read versioned acquisition options (VNC backends) without allocation or ownership recovery. |
| `relay_acquire` | Acquire a VM | `acquire` | Register the task, acquire a fresh VM, a guest, on the network `MCP_RELAY_GUEST_NETWORK` names and start its heartbeat; declare outputs before work. Answers `guest`, the guest's name in the session, which every later call on it names. Optional `vnc` prepares sharing without opening a viewer. |
| `relay_stage` | Stage the guest runtime | `stage` | Push and hash-check the runtime, support files and an opt-in workspace, all from the project folder. Needs only Node.js in the guest, and reports whether runs take snapshots (only when the image lists cua-driver). Failed staging can be retried; a staged runtime accepts corrected executable paths; `resetRecording: true` archives the recording and starts a new one on the same VM. |
| `relay_script` | Run a guest script | `run` | One recorded guest script in `language` (`shell`, `javascript`, `typescript` or `python`); a command is a shell script. `inline: true` takes the script as `code`, up to 1 MiB; `inline: false` takes `localPath`, a file in the project folder. `diagnostic: true`, for a shell script only, records diagnosis or repair without screenshot evidence, including before staging. |
| `relay_image` | Retrieve a saved image | `image` | Retrieve one saved display image, declared application image or immutable image reference without input, capture, directory export or acquisition. |
| `relay_extract` | Extract declared outputs | `extract` | Pull only declared files or directories with source and host checksum verification. |
| `relay_finish` | Finish and deliver evidence | `finish` | Extract the guest's declared outputs, deliver and verify its snapshot package, destroy its VM and unregister it; the session's other guests keep running. |
| `relay_release` | Release the VM | `release` | Retain the guest's available evidence and abandon or destroy its VM; the other guests keep running. When this session holds no guest, the result is an error that says nothing was released. |
| `relay_console_resolve` | Resolve console status | `console-resolve` | Resolve non-secret console status for the guest's lease and environment. |
| `relay_console_open` | Open console viewing | `console-open` | Open explicitly user-requested viewing on the service host, with `console_id`, `attempt_id`, `userRequested: true`, `reason` and `expected`. |
| `relay_console_cancel` | Cancel console viewing | `console-cancel` | Cancel the identified viewing attempt without releasing the VM. |
| `relay_status` | Show relay status | (unchanged) | Every guest this session holds, by name, each with its lease: backend binding, guest state, renewal state, console observation, last error, staging state and evidence path; plus `maxGuests`, the project directory, the machine-service origin and the selected environment. `active` is false when no guest's lease is being renewed. |

`readOnlyHint`/`idempotentHint` are true for `relay_search`, `relay_probe`,
`relay_acquisition_capabilities`, `relay_console_resolve`, `relay_image` and
`relay_status`; `destructiveHint` is true only for `relay_finish` and
`relay_release`, which destroy a guest's VM; `openWorldHint` is true only for
`relay_script`, whose guest code may reach the network.

`relay_command`, `relay_exec`, `relay_code`, `relay_run`, `relay_gate` and
`relay_tools` are gone (DC-23, DC-26, `docs/guest-code-runs.md` §10). A
command is a shell script: `{"argv":["ls","-al"]}` becomes
`{"language":"shell","inline":true,"code":"ls -al"}`. `relay_code` is
`relay_script` with `inline: true`. A run carries no kind. In place of
`relay_run`'s forwarded MCP tool calls, a script drives cua-driver, Playwright
or Chrome DevTools through their own libraries or command lines, as the image
lists them; the relay no longer stages MCP servers in the guest.

A run's result carries the execution identity and outcome, the derived step
record, and, when the snapshot plan captured the after phase and delivery
succeeded, the saved after-image as an MCP image content block. A run's
result also carries the guest's bounded standard output and error. The full
receipt stays in the evidence package.

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

- One server session holds several guests at once, up to `MCP_RELAY_MAX_GUESTS` (4 by default). `relay_acquire` names each guest, such as `login-test-1`, and every tool that acts on a guest takes that name as `guest`. Each guest keeps its own lease and heartbeat, its own evidence folder under `relay-evidence/`, its own background downloads, owner lock and registry row, and its own finish or release; finishing or releasing one leaves the others running. Calls on different guests run at the same time; calls on one guest keep their order. An acquisition beyond the limit is refused with the names of the guests held; the backend's own limits, such as two macOS VMs per host, still hold. An acquisition the host refuses for capacity waits for it, up to `MCP_RELAY_CAPACITY_WAIT`, then refuses with the backend's reason and the time waited; a waiting guest counts against the limit, and the backend's other refusals pass through at once.
- An operation failure retains the VM so the agent can inspect, repair and submit a new operation. Failed and uncertain operations are never automatically replayed.
- Use `finish` to deliver evidence and release, or `release` to abandon explicitly. A declared output that was never produced is recorded as incomplete (`incompleteExtractions`) rather than failing `finish`. A failed delivery retains the VM; a release failure retains ownership until destruction is verified.
- When the session ends (the client closes the server's standard input, a write to its standard output fails, it is signalled with SIGTERM, SIGINT or SIGHUP, or the process that started it goes away), `MCP_RELAY_ON_EXIT` says what happens to the guests. With `release`, the relay releases every guest the session holds through its own release path, keeping the evidence the host can still pull, then exits; an operation already in flight completes first, all within the shutdown grace period, after which a guest still held is released directly in one bounded attempt. A guest whose release fails keeps its record and stops renewing, so its lease ends within its last 15-minute window. With `pause`, the default, the relay renews each guest's lease once for the rest of its TTL, then renewal pauses and the recording detaches; no VM is destroyed and is retained until its TTL for an explicit finish or release. A `finish` or `release` already in flight completes first, for up to the shutdown grace period; after that the operation is cancelled and renewal pauses without it. The backend TTL and grace period handle abandoned leases. Status reports the last confirmed expiration time.
- While the session is live, the relay tracks the lease's own deadline (its start plus `ttlHours`) and renews machine-service only 15 minutes ahead at a time, never past that deadline, and stops renewing at it. A client that crashes without ending its session therefore leaves its VM leased for at most about 15 minutes, plus the backend's grace period, rather than its whole TTL.
- A restarted server with the same `MCP_RELAY_SESSION` reconciles each guest's durable ownership and reattaches its recording session without replaying prior work; every guest keeps its name. A session state written by a relay before several guests is restored as one guest named from its task. Context compaction does not reset VM state; `probe` reports the owned state without relying on earlier messages.
- A run tool's `timeoutMs` defaults to 120,000 ms and accepts integers up to 3,600,000 ms. It bounds command execution, not the snapshot delay or the lease lifetime. A timeout reports confirmed termination or uncertainty and keeps the VM available.
- A shell `relay_script` with `diagnostic: true` records diagnosis or repair without screenshots, for explicitly requested diagnosis when capture is unavailable. It runs through machine-service as `/bin/sh -c <script>`, a script file read on the host first: before staging in the guest's default directory, after staging in the recording workspace. Only a shell script may be diagnostic, because no receiver or Node.js is involved. It cannot join a snapshot group and is not visual verification.
- After diagnosing damaged recording state, `relay_stage` with `resetRecording: true` archives the old recording and starts a new recording session in the same VM. An existing receiver lock refuses the reset until its operation is reconciled. Prior evidence paths remain in the owned status.

## Runs

`relay_script` runs one script as one recorded operation; a command is a
shell script:

```json
{"guest":"login-test-1","language":"shell","inline":true,"code":"/usr/bin/xdg-open https://example.com"}
{"guest":"login-test-1","language":"python","inline":true,"code":"import subprocess\nprint(subprocess.run(['cua-driver','call','list_apps'],capture_output=True,text=True).stdout)"}
{"guest":"login-test-1","language":"typescript","inline":false,"localPath":"checks/login.ts"}
```

- **Evidence is automatic.** Every run is admitted by the guest receiver,
  journaled, and, when the image lists cua-driver, bracketed by a before and an
  after display snapshot. The step record is derived from the call: the title
  is a shell script's first line (`shell <line>`), `code (<language>)` or
  `script <file>`, and
  the expected result is "Exits with status 0". `reason`, `step` and
  `snapshots` are optional overrides; the default wait before the
  after-snapshot is 500 ms.
- **Scripts.** A `relay_script` with `inline: true` streams its `code` to the
  guest with its hash; with `inline: false` its `localPath`, a file in the
  project folder, is pushed hash-checked. The script runs in the staged
  workspace: shell with `/bin/sh`, JavaScript with the guest's Node.js,
  TypeScript with `tsx` or Node.js type stripping, Python with `python3`. The
  script's exit status says whether it succeeded: a script that calls
  cua-driver reads the driver's answer and exits nonzero on an error. A call that gives `code` and `localPath` other than
  as `inline` names is refused before anything reaches the guest.
- **One interaction per run.** A run is one recorded operation; consecutive
  keystrokes may form an explicit text group with `snapshots.group`. A script
  that drives several interactions records them as one step.
- **Outcomes.** A refused, uncertain or nonzero run is an error result and
  keeps the VM. Nothing is ever replayed.

## Saved images

A run tool names its saved after-image whenever the snapshot plan captures that
phase: a standalone event or a text group's last event. The result does not
wait for the image. Its `imageDelivery` is `pending` with the image identity
(`imageId`, `originalPath`, hash and size). In the background, one download at
a time, the relay brings each step's evidence to the host as one archive: its
before- and after-images and its receiver and action records. `relay_finish` and `relay_release` wait only for the download in
flight. They put the steps still queued, and every other file the host lacks,
into one archive of their own, and copy the files the step downloads already
brought instead of pulling them again. `relay_status` counts the steps whose
download a lifecycle operation took over as `coalesced`. A first or intermediate
group event and a diagnostic script do not invent an image. Execution and
image delivery are independent outcomes: a pending image does not turn a
failed run into a successful one. The delivery identity leads the result
text so it survives truncation. The design is `docs/screenshot-delivery.md`
§10.

`relay_image` shows a saved image. Asked for an image whose download is still
queued or running, it waits for that download within its own deadline. It
retrieves the same saved image through one closed selector; it never repeats input, creates a capture, exports the
consumer directory or acquires a VM:

```json
{"target":{"source":"display","sessionId":"<recording-session>","executionId":"<saved-execution>","phase":"after"}}
{"target":{"source":"application","name":"screens","path":"login/step-1.png"}}
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

## Durable machines

`relay_acquire` takes `machine` in place of `image` to lease a durable machine,
a real Mac that machine-service exposes, such as `Mac-A`. Every other
tool works on it as on a VM ([docs/durable-machines.md](docs/durable-machines.md)).

- The relay finds the instance that owns the machine as `machctl list` does:
  the loopback instance, then every instance that advertises
  `_machine-service._tcp` with Bonjour on the network, so a Mac needs nothing
  else installed. With `MACHINE_SERVICE_DISCOVERY=consul` it asks the Consul
  agent at `CONSUL_HTTP_ADDR` (default `http://127.0.0.1:8500`) instead. Each
  instance found is used only once its `/health` confirms its ID.
- Every call carries the lease's `lease_id`, files go as bytes, and the relay
  stages under the lease's workspace, which machine-service removes at release.
- When machine-service reports `machine_id`, the relay saves it and can resume
  the same lease after the Mac is renamed or its address changes. Requests keep
  using the name the lease was granted under. Older services keep the existing
  name and origin checks.
- A durable 404 never proves release. The relay finds the owner again and
  verifies that its machine record no longer names the lease. An unreachable
  owner leaves the lease retained with guest state `unknown`.
- Runs take snapshots only while the Mac's cua-driver daemon (`CuaDriver.app`,
  `com.trycua.driver`) holds Screen Recording, read with
  `cua-driver permissions status --json` in the lease. machine-service's own
  permissions are not read, and it needs no Screen Recording grant.
- A durable machine is on the home network and not isolated from it, a CI job
  may share its desktop, and it has no console.

## Selected environments

Set `VM_ENVIRONMENT_FILE` to a profile, at `schemaVersion` 2 with
`machctlPath`, that binds a loopback machine-service endpoint, an image repository, a Tart store and separate service, image and
relay state directories together. The profile is validated before use, is
authoritative over the individual `MCP_RELAY_*` variables, and an invalid
selection fails rather than falling back. Leases are bound to their backend and
store: an owned lease restored under a different environment fails before any
backend operation, and destruction is verified with the selected Tart binary
and `TART_HOME`. `docs/selected-environments.md` documents the schema. The
bundle the profile exports to subprocesses is the canonical one machine-service
defines, with `MACHCTL` and the `MACHINE_SERVICE_*` names, so its relay entries
keep the `VM_RELAY_STATE_DIR` and `VM_RELAY_URL` names and the three runtimes
agree; this server reads its own
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
time up to that TTL; the machine-service reaper is the final backstop for process death.

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
- `MCP_RELAY_URL`: the loopback machine-service origin, default `http://localhost:6240`. Non-loopback servers and redirects are refused; a durable machine's instance on another Mac is reached only when discovery finds it.
- `MACHINE_SERVICE_DISCOVERY`: how durable machines' instances are found, `bonjour` (the default) or `consul`, as for machine-service and machctl.
- `CONSUL_HTTP_ADDR`: the Consul agent that lists machine-service instances, in Consul mode; default `http://127.0.0.1:8500`.
- `MCP_RELAY_GUEST_NETWORK`: the network every guest is acquired on, `nat` (the default) or `internet`. With `internet`, machine-service gives a guest that reaches the internet and reaches neither this host nor any private network; an application that hosts agents sets it. The agent cannot choose it: `relay_acquire` takes no network. Any other value stops the server at startup and refuses every acquisition, and a machine-service that cannot give `internet` refuses the acquisition with its own reason, never falling back to `nat`.
- `MCP_RELAY_ON_EXIT`: what the end of a session does to its guests, `pause` (the default: renewal pauses and the VMs are kept for an explicit finish or release) or `release` (every guest is released, then the server exits). An application that owns its tasks' machines, such as The Desk, sets `release`. Any other value stops the server at startup.
- `MCP_RELAY_CAPACITY_WAIT`: how many seconds `relay_acquire` waits when the host is at capacity, such as at machine-service's limit of two running macOS VMs, asking again every 15 s; default 1800, and 0 for not at all. Any other value stops the server at startup.
- `MCP_RELAY_MAX_GUESTS`: the most guests one session holds at once, a positive integer, default 4. Any other value stops the server at startup.
- `MCP_RELAY_STATE_DIR`: host state, otherwise `$XDG_STATE_HOME/mcp-relay` or `~/.local/state/mcp-relay`, one subdirectory per session, with one `guests/<guest>/` folder per guest holding its ownership record and owner lock.
- `MCP_RELAY_REGISTRY`: an explicit task registry file; otherwise an existing compatible `~/AGENTS.md` VM table, or a private managed `registry.md` in the state directory.
- `MCP_RELAY_SHUTDOWN_GRACE_MS`: how long a session end waits for an in-flight operation, and with `MCP_RELAY_ON_EXIT=release` for the guests' releases, before cancelling it; default 120000.
- `MCP_RELAY_PYTHON`: the Python 3 used for the registry lock; default `python3` on PATH.
- `VM_ENVIRONMENT_FILE`: a selected environment profile; it overrides the URL, state directory and registry above and binds the Tart store.
- Guest files go to `/var/tmp/<UTC-timestamp>-mcp-relay-<task>/` on a VM and to `<lease workspace>/work/mcp-relay-<task>/` on a durable machine, with the runtime in `receiver.mjs`, support in `support/` and work in `workspace/`.

## Development

Build relay-driver using its own instructions, then in this checkout:

```sh
npm ci
npm run setup:dev -- /absolute/path/to/built/relay-driver
npm run check                                            # build, typecheck, tests
```

Three tests need something outside this repository and skip with a message
when it is absent: the console fixture regeneration needs a historical
`../vm-service` checkout with the Python backend (or
`VM_SERVICE_PYTHON_BACKEND`); the environment parity test needs
machine-service's `machctl` (`MACHCTL`, `PATH`, or a release build in
`../machine-service/rust`) and `../pilot-images`; and the shared catalog text
corpus needs `../pilot-images`. The JPEG and WebP presentation fixtures in
`tests/fixtures/` were encoded once from the test's spatial PNG with a codec
outside this repository and are committed, because the core carries none.

### End-to-end with headless Claude Code

```sh
npm run test:e2e
```

This runs `claude --print` with the plugin loaded from this checkout
(`--plugin-dir`), the model limited to the relay's tools, and the server pointed
at a loopback stand-in for machine-service (`tests/e2e/fixture-service.ts`), which
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
rebuilds `machctl`, checks the working build against a fresh one, and publishes
to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — no `NPM_TOKEN` secret involved), then creates the matching GitHub
release.

Trusted publishing has to be configured on npmjs.com, and npm requires the
package to already exist before you can do that. The **first** publish must
therefore be done by hand (`npm publish --access public` from a maintainer's
machine) before its trusted publisher can be configured for this workflow.

## License

MIT — see [LICENSE](LICENSE).
