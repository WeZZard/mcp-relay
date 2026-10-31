# Durable machines

This document is the design for DC-28 to DC-34 in [decisions.md](decisions.md#durable-machines). It is the relay's half of machine-service's [CN-1](../../vm-service/docs/arch/consumers.md#cn-1-mcp-relay).

## 1. Context

- A durable machine is a real Mac that machine-service exposes for exclusive leases. A lease on it is a session with a scratch workspace, not a fresh VM ([DM](../../vm-service/docs/arch/durable-machine.md)).
- The relay tools work on a durable machine as on a VM (DC-28). An agent names the machine instead of an image, and every other call, its order and its evidence stay the same.
- The relay reaches a VM through the loopback machine-service on its own host. A durable machine is usually owned by an instance on another Mac.

```mermaid
flowchart LR
  A[Agent] --> R[Relay]
  R -->|image| L[loopback machine-service] --> VM[VM]
  R -->|machine| C[Consul agent]
  C -->|machine-service registrations| R
  R -->|lease_id on every call| I[machine-service on the durable Mac] --> M[the Mac's GUI session]
  M --> D[cua-driver daemon: Screen Recording, Accessibility]
```

## 2. Choosing a machine (DC-29)

- `relay_acquire` takes exactly one of `image` and `machine`. `machine` is the durable machine's name as `machctl list` shows it, such as `Build-Mac-1`.
- The relay finds the instance that owns the machine, as machctl does ([FD-2](../../vm-service/docs/arch/federation.md#fd-2-discovery)):
  1. It asks the loopback instance at `MCP_RELAY_URL` (default `http://localhost:6240`) for `GET /machines`.
  2. It asks the Consul agent at `CONSUL_HTTP_ADDR` (default `http://127.0.0.1:8500`) for `GET /v1/health/service/machine-service`, and each registration's address and port for `GET /machines`. A registration published as `loopback_only` on another Mac is skipped.
  3. The owner is the instance whose list holds a record of `kind: "durable"` with that name. No owner, or two, refuses the acquisition before anything is reserved.
- The relay talks to a non-loopback origin only when Consul lists it as `machine-service`. The agent cannot name an address. Redirects and credentials in a URL stay refused.
- The guest's record keeps the owner's origin and instance ID. A restored guest finds its owner again, and refuses to act when the owner's origin or instance ID has changed.
- A durable acquisition sends `machine`, `purpose`, `ttl_hours` and `env`. It sends none of `image`, `network`, `vnc` or `wait`, which machine-service refuses for a durable machine, so `vnc` is refused before anything is asked.

## 3. Lease operations (DC-30, DC-34)

- Every operation on a lease carries its `lease_id`: exec, push, pull, heartbeat and release. machine-service requires it on a durable machine and accepts it on a VM, so one rule serves both.
- The relay reads a durable record as a lease: its `name` is the machine's name, and `image` and `image_kind` are `null`.
- `durable machine leased` and `durable machine unavailable` are capacity refusals. relay_acquire waits for them as for the macOS VM limit (DC-22).

## 4. Files and staging (DC-31)

- On a durable machine every file goes as bytes. A push is `PUT /machines/<name>/files?lease_id=<id>&path=<remote>` with the file as `application/octet-stream` and its SHA-256 in `X-Content-SHA256`. A pull is the matching `GET`, whose digest the relay checks before it keeps a byte. Both are single files, as every relay transfer already is. A pull streams to disk as it is hashed, so a file of any size takes no memory of its size, and it is abandoned only when no byte arrives for 120 s, however long the whole file takes.
- The relay's root on a durable machine is `<workspace>/work/mcp-relay-<purpose>`, where `workspace` is what acquisition returns. machine-service removes the workspace at release, after the relay has extracted its evidence.
- VMs keep the path-based push and pull and `/var/tmp/<UTC time>-mcp-relay-<purpose>`.

## 5. Snapshots (DC-32)

- On a VM the image catalog decides whether runs take snapshots (DC-13, DC-19).
- On a durable machine the decision is made at the first relay_stage from two facts:
  1. the machine's capabilities list `software.cua_driver`;
  2. `cua-driver permissions status --json`, run in the lease, answers for the daemon.
- The cua-driver command-line tool is a thin client: `cua-driver call` hands the work to the `cua-driver serve` LaunchAgent, which holds Screen Recording and Accessibility as `com.trycua.driver`. The daemon's grants are therefore the ones that apply, and machine-service's own `permissions` are not read. machine-service is never granted Screen Recording (DC-28).

| Answer | Decision | Snapshots |
| --- | --- | --- |
| `source.attribution` is `driver-daemon` and `screen_recording` is `true` | granted | taken |
| `screen_recording` is `false` | denied | none |
| the command fails, or its answer is not the expected JSON | unknown | none |
| `source.attribution` is anything but `driver-daemon` | daemon not running | none |
| the capabilities list no `cua_driver` | absent | none |

- relay_stage reports the decision and its reason under `snapshots`. A machine without snapshots is still staged, as an image without capture software is.
- When snapshots are taken, DC-24's wait for a screenshot proves capture before relay_stage returns.
- The tool's path is the app bundle's, `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`, because the login shell has no `cua-driver` on its `PATH` ([CN-3](../../vm-service/docs/arch/consumers.md#cn-3-what-a-durable-machine-needs-installed)). relay_stage's `cuaDriver` overrides it.

## 6. Release (DC-33)

- relay_finish and relay_release end the session with `POST /machines/<name>/release`, after the relay has extracted its evidence. machine-service stops the lease's processes, sweeps leftovers and removes the workspace.
- A durable release is verified when `GET /machines/<name>` no longer names the lease. There is no Tart list to read.
- The release's hygiene record is kept in the guest's `<evidence>.lifecycle.json`.

## 7. What a durable machine is not

- A durable machine is a real Mac on the home network. It is not isolated from the home network, and the network setting of DC-17 does not apply to it.
- Its desktop may be shared with a CI job ([HY-5](../../vm-service/docs/arch/hygiene.md#hy-5-coexistence-with-the-ci-runner)).
- It has no console operations.
- The relay's instructions and relay_acquire's description say so.
