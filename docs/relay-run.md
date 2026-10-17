# relay_run: forwarding MCP tool calls into the VM

> Removed by DC-23 ([guest-code-runs.md §10](guest-code-runs.md#10-two-ways-to-relay-an-action-dc-23)). `relay_run`, `relay_gate` and `relay_tools`, the guest MCP host and the pinned servers are gone; a script run with `relay_script` drives cua-driver, Playwright or Chrome DevTools through their own libraries or command lines. This document records the design as it was.

`relay_run` replaces `relay_cua` and `relay_browser`. The model sends the
tool calls it already knows for cua-driver, Playwright MCP or Chrome DevTools
MCP. The relay carries each call into the VM and records evidence around it.
`relay_tools` returns a target's real `tools/list`.

## The path of one call

```
relay_run {target, tool, args}
  host: stage the target if needed, start the guest MCP host if needed,
        fetch the target's tools/list once, check args against the tool's schema
  host -> guest receiver (one process per request, as for every run)
    admission journal, before-snapshot
    dispatch: node mcp-host.mjs call <stateDir> <target> <tool> <argsJson> <timeoutMs> <startMs>
      -> guest MCP host over a Unix socket
        -> the target server's own tools/call, through an MCP SDK Client
    wait afterIntervalMs, after-snapshot, execution-completion journal entry
  host: pass the tool's text and images through, attach the after-snapshot
```

The MCP client runs inside the guest, on the receiver's path. The receiver
journals the exact `call` argv, which holds the target, the tool and the
arguments. Nothing goes from the host to the guest around the receiver.

## The guest MCP host

The receiver is spawned once per request. Playwright MCP and Chrome DevTools
MCP keep their browser inside their own process, so a small detached process
(`dist/mcp-host.mjs`) holds the sessions. It follows the pattern of the
persistent guest browser it replaces:

- The relay pushes it hash-checked and starts it once, with `mcp-host.mjs
  start <config>`, before the first `relay_run` or `relay_tools`. Starting the
  host starts no server.
- It starts each target's server on first use, through the SDK's
  `StdioClientTransport`, and holds one SDK `Client` per target. The server
  inherits the host's environment. On Linux the host runs under SSH, which
  has no display, so it copies `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
  `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE` and
  `XDG_CURRENT_DESKTOP` from a desktop process of the same user, preferring
  the image's `cua-driver serve`. A fresh VM answers SSH before its desktop
  login finishes, so the host waits up to 30 s for that process before it
  starts a server. The browser then opens headed on the VM's display.
- It serves the per-request `call` client over a Unix socket in
  `<guestRoot>/mcp`. That directory is mode 0700 and the socket is mode 0600.
  The socket is addressed relative to that directory, which keeps it under
  the 104-byte `sun_path` limit whatever the lease root's length.
- It takes one call at a time. A second call while one runs is not sent.
- `relay_finish` and `relay_release` stop it, and with it every server, before
  outputs are extracted. A corrected `nodePath`, `cuaDriver` or
  `browserExecutable` on `relay_stage` also stops it, so the next call starts
  the servers with the new paths. Destroying the VM is the final cleanup.

## Targets, launch commands and pinned versions

All pins are in `src/targets.ts`.

| Target | Server | Launch (argv, cwd = guest workspace) |
|---|---|---|
| `cua` | the image's own `cua-driver` | `<cuaDriver> mcp`, plus `--no-overlay` on Linux |
| `playwright` | `@playwright/mcp` 0.0.82, with `playwright` and `playwright-core` 1.64.0-alpha-1789764292000 | `<node> <packages>/node_modules/@playwright/mcp/cli.js --isolated --output-dir <workspace>/relay-run/playwright/files [--executable-path <browserExecutable>]`, plus `--no-sandbox` on Linux |
| `chrome-devtools` | `chrome-devtools-mcp` 1.10.1 | `<node> <packages>/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --isolated --no-usage-statistics --no-performance-crux --no-page-id-routing --workspace <workspace> [--executablePath <browserExecutable>]`, plus `--chromeArg=--no-sandbox` on Linux |

- **cua.** `cua-driver mcp` is the MCP stdio proxy to the Cua Driver daemon.
  On Linux the daemon must already run as `cua-driver serve --no-overlay`,
  the same precondition `cua-driver call` had. `mcp` draws its own X11 cursor
  overlay unless it too gets `--no-overlay`. With the overlay, screen reads
  come from pixels saved under it that it cannot confirm, and the display
  snapshots come back black or stale. On macOS the proxy starts the CuaDriver
  app's daemon if none is running.
- **Browsers.** Both servers are headed by default, and the relay never
  passes `--headless`. Both use `--isolated`, so each start is a fresh browser
  profile. Without `browserExecutable` they use installed Google Chrome, the
  default channel of each server. Guests without Chrome, such as Linux arm64,
  need `browserExecutable` set to a Chromium path. On Linux both run
  Chromium without its sandbox: Ubuntu 24.04's AppArmor forbids the
  unprivileged user namespaces the sandbox needs, and the VM is the isolation
  boundary.
- **Chrome DevTools MCP page routing.** Page-ID routing is meant for several
  agents that share one browser, and it makes `pageId` required on
  page-scoped tools. It is turned off, because each guest has its own browser
  and the calls on one guest keep their order (DC-20).
  Tools such as `navigate_page` keep their usual shape and act on the
  selected page.

### How the packages reach the guest: staging, not npx

On the first use of a browser target, the host does three things:

1. It downloads each pinned npm tarball from the registry, or from the mirror
   in `MCP_RELAY_NPM_REGISTRY`.
2. It checks each tarball against its pinned `sha512` integrity, which is the
   value npm publishes, and caches it under the relay state root.
3. It pushes each tarball with the same hash-checked transfer that
   `relay_stage` uses. `mcp-host.mjs install` then checks each tarball's
   SHA-256 again and unpacks it into one flat `node_modules`.

A tarball that does not match its pin is never cached and never staged. This
approach was chosen over `npx` at first use for three reasons:

- The guest needs no network and no npm.
- Every byte the guest runs is pinned, including the transitive
  `playwright-core`, which `npx` would resolve at run time.
- The existing stage transfer already gives hash-checked delivery.

The staged closure is about 6.7 MB, made of four pure-JavaScript tarballs with
no install scripts. The host needs registry access once per version.

## Validation

The host checks `args` before anything reaches the guest receiver. It uses
Ajv, which the MCP SDK already depends on and which is bundled. The Ajv
dialect follows the schema's `$schema`: Playwright MCP emits 2020-12, and most
other servers emit draft-07. Formats are checked, and unknown keywords are
ignored. An unknown tool or a mismatch returns a refusal with the errors and
the tool's `inputSchema`, and nothing is sent. The guest MCP host checks the
same schema again right before `tools/call`, as a second line of defence.

The host fetches the list once per target, through `mcp-host.mjs tools`, and
keeps a copy in the host evidence under `host/mcp-tools/`. Fetching the list
starts the target's server outside a recorded step. Starting a server sends
no tool call. Neither browser server opens a browser before its first tool
call.

## Outcome mapping

| What happened | Receiver outcome | `relayOutcome` | Result |
|---|---|---|---|
| The host refused (unknown tool, schema mismatch, arguments over 64 KiB) | none: nothing was sent | `refused` | error; no snapshot |
| A held call was cancelled or its hold expired | `refused` | `refused` | error; no snapshot; no `lastError` |
| The guest never sent it: no host, host busy, server failed to start, server had already exited, guest schema check | `refused` | `refused` | error; snapshots kept |
| cua-driver's structured `desktop_escalation_required` | `refused` | `refused` | error |
| The server answered | `completed`, exit 0 | `completed` | success |
| The server answered `isError: true`, or with a JSON-RPC error | `completed`, exit 3 | `completed-with-tool-error` | error |
| No answer within `timeoutMs`, the server died mid-call, or the answer was unreadable | `uncertain` | `uncertain` | error; the server is stopped |

- Every error result keeps the VM. A failure after the call reached the
  receiver also records `lastError`; a host-side refusal sent nothing and only
  leaves a `relay-run-refused` host event.
- Nothing is replayed. A server that died is started fresh on the next call,
  and its lost session state is reported rather than recreated.
- The after-snapshot and the separate `imageDelivery` identity work as they do
  for every run.
- `timeoutMs` bounds the tool call itself. The receiver's dispatch bound adds
  60 s for a first-use server start and 15 s of margin.

## Result mapping

The call's result directory is `workspace/relay-run/<target>/<stamp>-<seq>-<tool>/`.
It holds `result.json` (the full result) and each image or binary block as its
own file. The `call` client prints a bounded summary of at most 48 KiB, with
text capped at 32 KiB and base64 kept out. That keeps the summary well below
the receiver's 64 KiB output limit.

The MCP content of a relay result comes in this order:

1. The relay's text: the execution identity, the outcome, the derived step,
   the tool image deliveries and `resultFile`.
2. The tool's own text blocks, within the relay's 50 KiB and 2000-line bound,
   with a truncation note that points at the result file.
3. The tool's images: up to four, delivered as application images of the
   `relay-run` extraction under the usual image bounds, and retrievable later
   with `relay_image`.
4. The relay's after-snapshot.

## Held input

A caller that must still decide whether a call may go can deliver it first
and decide while it travels. `relay_run` with `hold: {id, timeoutMs?}`
delivers the call to the guest receiver, which waits before its
before-snapshot and before any input. `relay_gate {hold, decision}` decides
it while the `relay_run` call is still waiting for its answer.

```
relay_run {target, tool, args, hold: {id}}      relay_gate {hold: id, decision}
  host: register the hold, then queue the run     host: not queued; one guest exec
  guest receiver: validate, routing journal,        writes <guestRoot>/holds/<id>
    input-hold journal entry, wait for the file
    go:   before-snapshot, dispatch, after-snapshot as usual
    else: refused, with no snapshot and no input
```

- The decision is a file, `<guestRoot>/holds/<id>`, written whole through a
  hard link, so the first writer wins. The receiver polls it about every
  20 ms.
- At the hold's limit, 60 s unless `timeoutMs` (at most 300 s) says
  otherwise, the receiver writes `expired` itself. A late `go` then finds
  `expired` in place, and the call is refused.
- `relay_gate` answers with the decision that stands and whether its own
  decision applied. Once the held run's receipt is in, it answers from the
  receipt and does not reach the guest.
- A hold id is used once per relay session. `relay_gate` on an id that no
  `relay_run` named is an error.
- The result of a held run carries `hold: {id, decision, waitedMs}`. A call
  not released is `refused` with "nothing was sent". It leaves a
  `hold-withheld` host event and does not record `lastError`, since the
  caller withheld it and the VM did not fail.
- The receiver's dispatch bound grows by the hold's limit.
- The journal records `input-hold` before the wait and `input-hold-decided`
  after it, with the decision and the wait.
- Only `relay_run` can be held. A command tool cannot.

## Default waits

The default is the wait from the end of the call to the after-snapshot.

| Target | Default `afterIntervalMs` | Why |
|---|---|---|
| `playwright`, `chrome-devtools` | 300 | Both servers wait for the page to settle before they answer. This wait covers the display catching up. |
| `cua` | 500 | cua-driver returns when input is dispatched, so native animations and dialogs need longer. |
| `relay_exec`, `relay_script`, `relay_code` | 500 | Same as `cua`. A command's visual effect is unknown. |

## Live checks

To repeat them, build and run one step file per image. Each acquires, uses
and finishes a real VM through the local vm-service:

```sh
npm run build
node scripts/live-check.mjs scripts/live-checks/ubuntu.json <outDir>
node scripts/live-check.mjs scripts/live-checks/macos.json <outDir>
```

The script exits nonzero when any step's result differs from what its step
file expects, and saves every result and image in `<outDir>`.

Run on 2026-09-24 against `ubuntu2404` (arm64, GNOME on X11) and `macos26`
(26.6.1) with the local vm-service:

1. `cua`: `get_screen_size` answered on both images (3840x2160 on Ubuntu,
   1920x1080 on macOS), and `list_apps` answered on Ubuntu.
2. On macOS, `launch_app` Calculator, `get_window_state`, then two `click`s
   on the 7 button by element index; the after-snapshot shows 77.
3. `playwright` `browser_navigate` and `browser_snapshot`: the pinned
   tarballs were staged, and the page shows headed in the after-snapshot on
   both images. Ubuntu used `browserExecutable` set to Playwright's
   Chromium; macOS used installed Google Chrome.
4. `chrome-devtools` `navigate_page` and `take_screenshot`, with the inline
   tool image, on both images.
5. `relay_finish` delivered a verified package with the `relay-run`
   extraction (per-call results, `playwright/files`, `servers/*.log`). The
   host stop is logged; the VM is destroyed right after it, so no process
   check follows the stop.
6. Refusals: arguments that break a tool's schema, and a tool name the
   target lacks, were refused with nothing sent.

These runs found the Linux display, Chromium sandbox and cua overlay
problems described above, and a preview failure on macOS captures, which
carry an ICC profile (`iCCP`) and XMP (`iTXt`). The preview now accepts
those chunks without inflating them.
