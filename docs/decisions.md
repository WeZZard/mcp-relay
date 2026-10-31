# Decisions

Decisions are the person's own. A decision marked "on the agent's recommendation" was proposed by the agent and accepted by the person.

## Screenshot delivery

The design is [screenshot-delivery.md §10](screenshot-delivery.md#10-background-download-of-step-evidence).

| ID | Decision | Owner |
|---|---|---|
| DC-1 | The guest captures the screenshot at once. The host downloads it in the background. Returning the screenshot's path in the `relay_run` result does not depend on the download. | The person (2026-10-02). |
| DC-2 | `relay_run` always returns without waiting for its screenshot download. There is no option to wait. | The person (2026-10-02). |
| DC-3 | The background downloads block `relay_finish` and `relay_release`: both wait until every queued download has ended. | The person (2026-10-02). |
| DC-4 | One download worker per enclosure, with a bound of 64 queued downloads. Tune both from the verification run. | The person, on the agent's recommendation (2026-10-02). |
| DC-5 | Retry backoff of 1 s, then 3 s, within a download's three attempts. | The person, on the agent's recommendation (2026-10-02). |
| DC-6 | `relay_finish` reuses the screenshots the host already holds. | The person, on the agent's recommendation (2026-10-02). |
| DC-7 | The worker pauses after a transient failure. When a lifecycle operation lifts the pause and the next download fails again, the operation cancels the rest of the queue and pulls those originals itself. | The person, on the agent's recommendation (2026-10-02). |

## Held input

The design is [relay-run.md, Held input](relay-run.md#held-input). DC-23 removed `relay_run` and `relay_gate`, so held input is gone with them.

| ID | Decision | Owner |
|---|---|---|
| DC-8 | `relay_run` can deliver a call and hold it in the guest until `relay_gate` releases it, so a caller's check runs while the call travels. A call not released is refused with nothing sent. The hold sits before the before-snapshot; the decision is a file in the guest, and the first writer wins; the limit defaults to 60 s, at most 300 s; a withheld call is not a VM failure. | The person (2026-10-04), for pi-secretary's guardian (its decision PS-D45). The placement, the file signal, the limits and the failure rule are the agent's defaults. |

## Evidence download

The design is [screenshot-delivery.md §10](screenshot-delivery.md#10-background-download-of-step-evidence).

| ID | Decision | Owner |
|---|---|---|
| DC-9 | The host downloads each step's evidence in the background while the agent uses the VM: its screenshots, its records and its tool result. Each step queues one download. | The person (2026-10-08). |
| DC-10 | The host keeps each step's downloaded evidence in a folder of its own. | The person (2026-10-08). |
| DC-11 | `relay_finish` and `relay_release` coalesce the downloads still pending into one: they put what the host lacks into a single archive in the guest, download it, and unpack it on the host. | The person (2026-10-08). |

## Code runs in any guest

The design is [guest-code-runs.md](guest-code-runs.md).

| ID | Decision | Owner |
|---|---|---|
| DC-12 | The relay keeps vm-service as its only backend. A Docker-sandbox backend waits until a task needs it: on a Mac, Docker runs inside a Linux VM, so a container adds no isolation over a Linux VM, and no Docker image lists the software the agents use. | The person, on the agent's recommendation (2026-10-17). |
| DC-13 | Staging and runs assume no software. `relay_stage` pushes only the relay's own code, which needs Node.js; it pushes no runtime, and an image without Node.js cannot be staged. A run takes snapshots only when the image lists capture software, cua-driver. The images list the software they hold, such as cua-driver, Playwright and Chrome DevTools, and the agent writes code against it. | The person (2026-10-17). |
| DC-14 | The relay no longer tells the agent to relay only interruptive work. Its server instructions, `relay_probe`'s description and recommendation, the operator agent and the README drop the rule. | The person, on the agent's recommendation (2026-10-17). |
| DC-15 | Every host file the relay reads, `relay_stage`'s `files[].local` and `workspace` and `relay_script`'s `localPath`, lies in the project folder, absolute paths included. | The person, on the agent's recommendation (2026-10-17). |
| DC-16 | The project is renamed from mcp-vm-relay to mcp-relay. The package, the plugin, the repository and the environment variables follow: `MCP_VM_RELAY_*` becomes `MCP_RELAY_*`, with no fallback to the old names. | The person (2026-10-17). The renamed parts and the absence of a fallback are the agent's defaults. |
| DC-17 | The relay acquires each guest on the network that `MCP_RELAY_GUEST_NETWORK` names, `nat` by default, through vm-service's `network` (its DC-13). An application that hosts agents, such as The Desk, sets `internet`, so a guest reaches neither the host nor the home network. The agent cannot change it. | The agent (2026-10-17), as the owner leaves technical choices to the agent. |
| DC-18 | With the rename, the relay's default state directory becomes `mcp-relay`, and leases the old relay owns are finished or released before the upgrade. The lock beside a registry file keeps its name, `.mcp-vm-relay.lock`, so a relay of an earlier release that edits the same registry, such as `~/AGENTS.md`, still excludes this one. | The agent (2026-10-17), as the owner leaves technical choices to the agent. |
| DC-19 | The relay learns whether an image lists capture software from the catalog at the first `relay_stage` of a lease. When the catalog cannot be read, `relay_stage` refuses rather than staging without snapshots. | The agent (2026-10-17), as the owner leaves technical choices to the agent. |
| DC-20 | One relay session holds several guests at once, so an agent and its subagents can work on several machines in parallel, such as to test software on two machines together. `relay_acquire` names each guest, every tool that acts on a guest takes that name, and each guest keeps its own lease, heartbeat, evidence, downloads, finish and release. A session holds at most `MCP_RELAY_MAX_GUESTS` guests, 4 by default; the backend's own limits, such as two macOS VMs per host, still hold. This replaces "one task gets one enclosure". | The person asked for several machines per agent (2026-10-17); the naming, the limit and its default are the agent's. |
| DC-21 | `MCP_RELAY_ON_EXIT` says what the end of a session does to its guests. `pause`, the default, pauses each guest's lease renewal and keeps its VM for an explicit finish or release, as before. `release` releases every guest the session holds through its own release path, bounded in time and waiting for nothing an agent would have to see, then exits. An application that owns its tasks' machines, such as The Desk, sets `release`, so no machine outlives its session. Any other value stops the relay at startup. | The person asked for machines that never outlive their session (2026-10-17); the variable's name, its values and default, the session ends it covers and the time bounds are the agent's. |
| DC-22 | When vm-service refuses an acquisition because the host is at capacity, its 409 for the macOS VM limit, `relay_acquire` waits for capacity instead of failing: it asks again every 15 s for up to `MCP_RELAY_CAPACITY_WAIT` seconds, 1800 by default, 0 for not at all. It stops at once when the call is cancelled or the session ends. A waiting guest keeps its name and counts against `MCP_RELAY_MAX_GUESTS`, and the limit's refusal says it is waiting. When the wait runs out it refuses with vm-service's reason and the time waited; a granted acquisition says how long it waited. Any other refusal passes through at once. Any value but a nonnegative integer stops the relay at startup. | The person asked that an acquisition wait for capacity (2026-10-17); the interval, the default, and counting a waiting guest against the limit are the agent's. |
| DC-23 | A guest runs an action in one of two ways. `relay_command` runs one command, `argv`; it is `relay_exec` renamed, `diagnostic` included, so a guest can be diagnosed and repaired before `relay_stage`. `relay_script` runs a script in JavaScript, TypeScript or Python: with `inline: true` it takes the code itself, `code`, and with `inline: false` a file in the project folder, `localPath`. The script drives whatever the image lists, such as cua-driver or Playwright. `relay_exec`, `relay_code`, `relay_run`, `relay_gate` and `relay_tools` are removed, with `relay_run`'s MCP targets and the servers the relay staged for them. The tools that manage a guest stay. | The person (2026-10-17). |
| DC-24 | When the image lists capture software, `relay_stage` waits until the guest's cua-driver takes a screenshot before it returns, asking every 2 s for up to 120 s. An image starts cua-driver's daemon at login, which can follow the guest's readiness, so without the wait the first runs were refused for a missing before-snapshot. A daemon that never answers refuses the stage with its error, and nothing is staged; the guest is kept, so the agent can start the daemon with a diagnostic `relay_command` and stage again. | [Agent] (2026-10-18), from the live run of DC-23 on `ubuntu2404`. |
| DC-25 | `relay_script` runs TypeScript with `tsx` from the guest's `PATH`, or, when the guest has none, with the guest Node.js's own type stripping, 22.6 or later. The receiver picks the runtime before the run, and a run whose runtime is missing, such as Python without `python3`, is refused before anything starts, rather than ending `uncertain`. `relay_probe` reports TypeScript as ready when either runs. | [Agent] (2026-10-18), from the live run of DC-23 on `ubuntu2404`, which has no `tsx`. |
| DC-26 | A guest runs everything as a script, through one tool, `relay_script`. A command is a shell script, so `relay_command` is removed, and `relay_script` takes `language: "shell"` beside JavaScript, TypeScript and Python. A run no longer carries a kind, in the tool call, the relay's run input, the guest request or the guest journal: the relay tells a script given inline from a script file by `inline`, and the guest tells them by whether the request holds the code itself. | The person (2026-10-18). The language name `shell`, running it with `/bin/sh`, keeping `diagnostic` for shell scripts only, and dropping the receiver's reading of a `cua-driver call` command's answer are the agent's. |

## The backend is machine-service

vm-service is renamed machine-service, and the relay switches to the new names in the same milestone as the service and its other callers, with no compatibility window (machine-service's DC-33, DC-37, DC-41 and DC-42, and its [MG-3](../../vm-service/docs/arch/rename.md#mg-3-one-coordinated-switch)). The design is [selected-environments.md](selected-environments.md) and the README's opening and "Selected environments".

| ID | Decision | Owner |
|---|---|---|
| DC-27 | The relay speaks only machine-service. Its client (`src/machine-service.ts`) asks for `/machines` and `/machines/<name>/...` and reads the list's `machines`; it never asks for `/vms`, which now answers 410 Gone. The doctor, and the identity check before a selected environment's lease operations, refuse a service whose `/health` does not answer `"service": "machine-service"`, naming what to install. The environment loader reads only a profile at `schemaVersion` 2 with `machctlPath`; a profile at version 1 or with `vmctlPath` is refused with an error that names `machctlPath` and `schemaVersion` 2, and the old field is never read. The exported bundle carries `MACHCTL`, `MACHINE_SERVICE_STATE`, `MACHINE_SERVICE_HOST` and `MACHINE_SERVICE_PORT` in place of the `VMCTL` and `VM_SERVICE_*` names, exactly as `machctl environment --json` does. The relay's own names stay: `MCP_RELAY_*`, `VM_ENVIRONMENT_FILE`, `VM_ENVIRONMENT_FINGERPRINT`, `VM_RELAY_*`, the profile's `vmServiceUrl` and the state directories. A registry row and a recording target name `machine-service`. | The person approved the coordinated rename (machine-service's DC-33, DC-41, 2026-10-21). The module's new name, refusing an old service by its `/health` answer, and keeping `vm-service` among the protected default state roots beside `machine-service` are the agent's. |

## Durable machines

The relay tools work on durable machines, the Mac minis that machine-service exposes, as they work on VMs. This is the relay's half of machine-service's [CN-1](../../vm-service/docs/arch/consumers.md#cn-1-mcp-relay). The design is [durable-machines.md](durable-machines.md).

| ID | Decision | Owner |
|---|---|---|
| DC-28 | The relay tools work on durable (bare-metal) machines exactly as on VMs: relay_acquire, relay_stage, relay_script, relay_image, relay_extract, relay_finish and relay_release, with the same names, order and evidence. GUI work on a durable machine goes through the relay and cua-driver, and machine-service is never granted Screen Recording. | [User] (2026-10-31). |
| DC-29 | relay_acquire takes `machine`, a durable machine's name, in place of `image`; exactly one of them. The relay finds the instance that owns the machine the way machctl does: the local instance, then every `machine-service` registration the Consul agent at `CONSUL_HTTP_ADDR` lists (default `http://127.0.0.1:8500`), each asked for `GET /machines`. It talks to a non-loopback instance only when Consul lists it, never to an address the agent or a URL names, and still refuses redirects and credentials. | [Agent] (2026-10-31), as the owner leaves technical choices to the agent. |
| DC-30 | Every lease operation carries the lease's `lease_id` when the lease has one, on a VM as on a durable machine: machine-service requires it on a durable machine and accepts it on a VM. | [Agent] (2026-10-31). |
| DC-31 | On a durable machine the relay copies every file as bytes, through `PUT` and `GET /machines/<name>/files`, and stages its runtime under the lease's workspace, `<workspace>/work/mcp-relay-<purpose>`, which machine-service removes at release. VMs keep the path-based push and pull and `/var/tmp`. | [Agent] (2026-10-31). |
| DC-32 | On a durable machine a run takes snapshots when the machine's capabilities list `software.cua_driver` and `cua-driver permissions status --json`, run in the lease, answers `source.attribution: "driver-daemon"` with `screen_recording: true`. machine-service's own `permissions` are not read, because the cua-driver daemon, not machine-service, captures the screen. `screen_recording: false` is denied; a failed or unreadable answer is unknown; any other attribution means the daemon is not running. In each of those cases runs take no snapshots and relay_stage says why. DC-24's screenshot wait then proves capture, as on a VM. | [Agent] (2026-10-31), on the person's decision DC-28. |
| DC-33 | A durable release is verified when the machine's record no longer names the lease, instead of by Tart's list. The relay keeps the release's hygiene record in the guest's `.lifecycle.json`. | [Agent] (2026-10-31). |
| DC-34 | machine-service's 409s `durable machine leased` and `durable machine unavailable` are capacity refusals: relay_acquire waits for them as for the macOS VM limit (DC-22). | [Agent] (2026-10-31). |
| DC-35 | The relay finds a durable machine's owner in the mode `MACHINE_SERVICE_DISCOVERY` chooses, as machine-service and machctl do (machine-service DC-84, DC-85): `bonjour` by default, through its own one-shot Multicast DNS query for `_machine-service._tcp.local`, or `consul` through the Consul agent as DC-29 set. Every instance found that way is used only once its `/health` answers the ID it was found under, and one instance reached twice counts once. This replaces DC-29's Consul-only discovery; the rest of DC-29 stands. | [User] (2026-10-31), machine-service DC-84; the query and the confirmation are the agent's. |
