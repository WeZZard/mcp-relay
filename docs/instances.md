# Every instance

This document is the design for DC-7x-FED-1 to DC-7x-FED-6 in [decisions.md](decisions.md#every-instance). It is the relay's half of machine-service's [FD-7](../../vm-service/docs/arch/federation.md#fd-7-catalog-questions-and-image-acquisition) and [CN-1](../../vm-service/docs/arch/consumers.md#cn-1-mcp-relay).

## 1. Context

- The search contract and the relay were designed when machine-service ran on one Mac and the relay ran on that same Mac, so the loopback instance was the whole lab.
- machine-service now runs on several Macs, and a Mac may run an instance that offers nothing (machine-service DC-93). Before this design, relay_search, relay_probe, relay_acquisition_capabilities, the image catalog checks of relay_stage and relay_probe, and every image acquisition asked only the loopback instance. A relay on a Mac that offers nothing therefore answered an empty catalog, `{"applications":[],"truncated":false}`, while the Macs that host the virtual machines listed the application, and it could not acquire a virtual machine at all.
- Only the owner of a durable machine was found across instances (DC-29, DC-35).

## 2. Finding the instances (DC-7x-FED-1)

- The relay finds instances as machctl does, and as it already finds a durable machine's owner ([durable-machines.md §2](durable-machines.md#2-choosing-a-machine-dc-29-dc-35-dc-37)): the loopback instance at `MCP_RELAY_URL`, then every instance that Bonjour or Consul lists, in the mode `MACHINE_SERVICE_DISCOVERY` chooses, each confirmed by its `/health` and its `machine_id`. The same instance found twice, such as the loopback instance and its own advertisement, counts once by `machine_id` and port.
- The relay talks to an origin off loopback only when discovery found it. The agent can name an instance, but never an address that discovery did not find.
- The loopback instance is the configured one and is always asked. Its `/health` only names it, so only a request that reaches nothing at all makes it unreachable.
- Each instance is named by the name its `/health` answers. A former name and a `machine_id` name it too.
- An instance that does not answer stays in every answer as unreachable, with its error. A discovery that fails, or that a test process may not run (DC-67), is reported beside the loopback instance as `discovery`, and the loopback instance still answers.
- A selected environment pins its own instance, so under one the relay asks only that instance and runs no discovery (machine-service DC-64).

## 3. Questions (DC-7x-FED-2, DC-7x-FED-3)

- relay_search, relay_probe with `scope: "host"`, and relay_acquisition_capabilities take an optional `instance`, which narrows the question to one instance. When no instance has that name, Bonjour looks once more after 2 seconds (machine-service MI-5), and the call is then refused with the instances there are.
- **relay_search** asks each instance for `/applications`, and for `/images` to learn the catalog's generation and status. It matches each catalog on its own, by the rules of the [search contract](search-contract.md#matching). An installation that several instances offer with the same facts is listed once, with an `instances` list that names each instance, its `machine_id` and its catalog `generation`. An installation whose facts differ between instances, such as a version that one Mac has not yet synced, is listed once for each set of facts. The result's top-level `instances` lists every instance asked, with whether it answered, its catalog's generation and status, or its error. The response budget counts the whole result, these lists included. The search is an error only when no instance answered with a valid catalog, so an empty result still means that no catalog lists the application.
- **relay_probe** with `scope: "host"` reports, under `relay.instances`, each instance's name, `machine_id`, origin, images and capacity. `relay.reachable` is true when any instance answered.
- **relay_acquisition_capabilities** reports each instance's capabilities, or its diagnostic, under `instances`. It is an error only when no instance answered.
- A guest's own questions, relay_probe with `scope: "guest"` and the capture check of relay_stage, ask the instance that owns the guest's lease.

## 4. Image acquisition (DC-7x-FED-4)

- relay_acquire with `image` and no `instance` chooses among the instances whose `/images` lists the image with its base built, and, when `vnc` is asked, with a VNC backend for the image's OS. An acquirable offer comes before one that is not. Within each group the loopback instance comes first, then the others by name. This is the order of `machctl acquire` (machine-service FD-7, CL-2).
- The relay asks the candidates in order. It records each choice and its reason as an `acquire-choice` event in the guest's evidence, and the result's `chosen` names the instance that granted the lease and why. A capacity refusal passes to the next candidate. When every candidate refuses for capacity, the acquisition waits and asks them all again, as DC-22 sets for one instance.
- `instance` pins the acquisition to one instance. `instance` with `machine` is refused, because a durable machine names its own instance.
- When no instance offers the image, the acquisition is refused before anything is reserved, and the message names what each instance offers.

## 5. A lease on another instance (DC-7x-FED-5)

- The guest's record keeps the owning instance's origin, name and `machine_id`, as it does for a durable machine. Every later call on the guest goes to that instance: heartbeat, exec, transfers, the catalog check of relay_stage, release, and the check that the VM is gone, which reads the owner's `/machines`, because this host's Tart store does not hold the VM.
- A restored guest finds its owner again by `machine_id` and port, across a rename or a change of address (machine-service MI-5, MI-6). A guest saved without a `machine_id` requires its original name and origin.
- Files to and from a VM on another instance go as bytes, as they do for a durable machine (machine-service FD-4, DC-31), because a host path on this Mac means nothing to an instance on another Mac.
- A lease on the loopback instance keeps its binding of the loopback origin and this host's Tart store, unchanged.

## 6. The relay link (DC-7x-FED-5)

- Each lease's broker session goes to the `relay_url` that the lease's own instance advertises, with the grant its acquisition returned ([relay-agent-link.md §3](relay-agent-link.md#3-the-session-with-the-broker)). The relay keeps the grant with the backend of that instance, so two leases on two instances each use their own broker.

## 7. How this is proved (DC-7x-FED-6)

- `tests/federation.test.ts` runs a client Mac whose instance offers nothing, two instances that host VMs with different catalog generations, and a stopped one, through the injected Bonjour seam. It checks relay_search's instances and generations, `instance` narrowing, relay_probe and relay_acquisition_capabilities per instance, an acquisition that goes to a host and says why, a capacity refusal passing to the next instance, a pinned instance, a restart that finds the owner again after a rename, and that local-only discovery never browses.
- `scripts/live-federation.ts` is the opt-in live regression. It browses the network at run time and names no instance, reads each instance's own catalog, and checks that the built relay's relay_search and relay_acquisition_capabilities name every instance that lists the application, while the relay's loopback instance offers nothing. It is read-only. It failed on the relay before this design, which answered an empty search.
