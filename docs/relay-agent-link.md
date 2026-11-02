# The relay agent link

## 1. Context

- machine-service is replacing SSH with a relay agent, a daemon that runs in the desktop session of each machine's logged-in user, and a broker inside machine-service that relay agents and clients both dial out to. The design is in vm-service's [relay agent](https://github.com/WeZZard/vm-service/blob/main/docs/arch/relay-agent.md), [broker](https://github.com/WeZZard/vm-service/blob/main/docs/arch/broker.md) and [transport contract](https://github.com/WeZZard/vm-service/blob/main/docs/arch/transport-contract.md).
- Today the relay sends each guest operation as one HTTP request to machine-service (`src/machine-service.ts`), and machine-service runs it over SSH, outside the desktop session.
- This document covers what the relay changes to send its operations through the broker.

## 2. What changes and what stays

| Part | Today | With the relay agent link |
| --- | --- | --- |
| Discovery | Bonjour or Consul, then `/health` | the same, and the relay reads `relay_url` from the instance |
| Acquire, heartbeat and release | HTTP to machine-service | unchanged |
| Exec, script and transfers | one HTTP request each, run over SSH | operations of one resumable session with the broker |
| A broken connection | the operation's outcome is unknown | the session resumes, and a query by execution ID gives the outcome |
| Evidence and snapshots | relay-driver's receiver in the guest | unchanged; the receiver runs as a child of the relay agent |
| The relay's own host | an Apple-silicon Mac only | macOS or Ubuntu |

## 3. The session with the broker

- The relay opens one resumable session per lease with the broker at the instance's `relay_url`, authenticated with the lease credential that the acquisition returned, which binds the session to that lease's relay agent (DC-4x-CL-2).
- Every operation carries the relay's execution ID, which the relay already records for each run, so a resumed session never runs an operation twice.
- After any loss that the session cannot resume, the relay asks `query {execution}` and reports `completed`, `running` or `unknown`. An `unknown` outcome stays uncertain, and the relay never replays it, as the relay already does for timeouts.
- The relay sends data in chunks of at most 1 MiB and sends a heartbeat at least every 30 seconds, as the transport contract requires.

## 4. Running on Ubuntu

- The relay acceptance runs the client on Ubuntu as well as on macOS, so the relay must run on Ubuntu.
- `relay doctor` refuses any host that is not an Apple-silicon Mac today. That check moves to the commands that need local Tart, and the remote path accepts an Ubuntu host.
- The relay browses Bonjour through macOS's `dns-sd -Z` today (DC-40). On Ubuntu it browses through Avahi's `avahi-browse`, or through its own multicast query when Avahi is absent.

## 5. relay-driver

- relay-driver's receiver runs in the guest for each action and records the journal and the snapshots. The relay agent starts it as a child process, in the desktop session, instead of an SSH session starting it.
- The receiver must produce byte-identical evidence packages through either link, which the relay's existing package verification checks.
- The relay-driver packages (`@wezzard/relay-driver-*`) need a change only if the receiver assumes an SSH session, which the implementation checks first.

## 6. Fallback

- When machine-service reports `link: ssh-fallback` for a lease, the relay keeps using the HTTP operations, and it reports the fallback in the guest's status, because an action over SSH runs outside the desktop session.
