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
