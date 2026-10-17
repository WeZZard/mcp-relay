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

The design is [relay-run.md, Held input](relay-run.md#held-input).

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
| DC-23 | There is one way to relay an action: `relay_code`. It runs code in a guest, in JavaScript, TypeScript or Python, and the code drives whatever the image lists, such as a shell command, cua-driver or Playwright. `relay_exec`, `relay_script`, `relay_run`, `relay_gate` and `relay_tools` are removed, with `relay_run`'s MCP targets and the servers the relay staged for them. `relay_code` takes `diagnostic` from `relay_exec`, so a guest can be diagnosed and repaired before `relay_stage`. The tools that manage a guest stay. | The person (2026-10-17). Moving `diagnostic` to `relay_code` is the agent's. |
