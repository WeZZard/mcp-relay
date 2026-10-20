# Guest-sharing console integration

## Implementation and verification boundary

- The relay source implements the consumer contract for unmodified Tart with service-owned guest sharing. It does not invoke Tart's private protocol, run a viewer itself, discover guest ports, or obtain credentials.
- The matching machine-service guest-sharing backend is implemented. Configured availability, stock-Tart compatibility, guest preparation, access revocation, and actual viewer rendering require separate operational checks and live acceptance. [Verification](verification.md#console-rollout-status) records rollout observations; they are not permanent design prerequisites.
- The tests use mocked backends and offline provider serialization. They do not establish a live viewing pass, authentication, correct displayed pixels, or human confirmation.
- This document defines the console fields used by the main [technical design](technical-design.md#38-live-viewing-of-the-owned-vm) and [UX flow](ux-design.md#68-live-viewing-of-the-owned-vm). The original [investigation](live-view-investigation.md) is historical; security and live acceptance requirements remain in force.

## Platform and configuration boundary

- machine-service owns guest sharing and opens a trusted standard viewer in the service host's logged-in graphical session. It uses ordinary unmodified Tart boot, not Tart's experimental VNC or a private runtime patch.
- Linux requires the SSH user's existing X11 console, Python 3, logind session metadata, xdpyinfo, and x11vnc. The backend uses x11vnc inetd over SSH without a guest VNC TCP listener and enforces view-only access at the server. TurboVNC receives its password through a private stdin interface. Wayland and newly created remote desktops are unsupported.
- macOS requires the existing console user, Python 3, supported built-in Screen Sharing configuration, and guest PF/listener checks. Apple's standard viewer prompts for guest-account authentication. Standard sharing of the existing console is required; a separate Log In session or High Performance display is not equivalent. Guest PF checks do not replace external IPv4/IPv6 isolation tests or safe boot-order acceptance.
- Configuration is loaded at service startup and is disabled by default. Discovery reports that snapshot, not a live image test. Acquisition with `vnc: true` checks the actual guest; it is not permission to modify images or silently install prerequisites.
- [Backend installation](../../vm-service/docs/vnc-installation.md), [guest preparation](../../vm-service/docs/guest-console-provisioning.md), and [live acceptance](../../vm-service/docs/vnc-acceptance.md) own the detailed platform procedures. These sibling-checkout links require machine-service alongside this repository.

## Relay tools

- `relay_acquisition_capabilities` takes no fields. It reads the versioned backend options without initializing or recovering ownership, allocating a VM, or opening a viewer.
- `relay_acquire` accepts optional boolean `vnc`. Omission retains the old wire request; explicit `false` is forwarded. `true` checks OS availability before allocation and requires a ready console and lease identity in the acquisition response. It never opens a viewer.
- `relay_console_resolve` takes no fields. The manager derives the VM and lease identity from durable ownership, reconciles the selected backend, and resolves the console without opening it.
- `relay_console_open` requires `console_id`, `attempt_id`, `userRequested: true`, `reason`, and `expected`. The agent may call it only for an applicable explicit user request. The boolean is a declaration, not independently verified user authorization.
- `relay_console_cancel` requires `console_id` and `attempt_id`. It cancels managed viewing resources without releasing the VM, changing lease-renewal policy, or ending guest work.
- These tools reject screenshot metadata, executable paths, connection URLs, VM selectors, and environment overrides. They do not produce screenshot evidence. Existing run-tool admission and snapshot rules remain unchanged.
- Opening retains `reason` and `expected` as local intent annotations. They are not screenshot, authentication, pixel, or human-confirmation evidence. The other tools here take no `reason`.

Each line below is one tool's call arguments (the tool's own name already carries what used to be its `action`):

```json
relay_acquisition_capabilities {}
relay_acquire {"task":"watch-task","image":"IMAGE_FROM_DISCOVERY","extractions":[],"vnc":true}
relay_console_resolve {}
relay_console_open {"console_id":"CONSOLE_FROM_RESOLVE","attempt_id":"watch-1","userRequested":true,"reason":"The user explicitly asked to watch this task.","expected":"The standard viewer opens on the service host; authentication may still require the user."}
relay_console_cancel {"console_id":"CONSOLE_FROM_RESOLVE","attempt_id":"watch-1"}
```

## Backend API expectations

- `GET /acquisition-capabilities` returns `schemaVersion: 1` and `options.vnc`, whose `default` is `false` and whose `backends.linux.available` and `backends.macos.available` are booleans. An old endpoint, unknown version, or malformed document produces an explicit error rather than ordinary acquisition as a fallback.
- Backend capability records include `status`, `backend`, `viewer_location`, `authentication` as a mechanism, `guest_readiness`, `session_binding`, `server_enforced_view_only`, `pixels`, and `human_confirmation`. Relay preserves these limitations. Missing fields remain `unknown`; availability does not prove live image readiness.
- A VNC-enabled acquisition returns the ordinary lease record with immutable `lease_id` and `console: {console_id, status: "ready", backend, ...}`. Ordinary legacy records remain usable without these additions.
- `GET /machines/<vm>` must retain the same `lease_id` and acquisition console identity. A replaced lease or console instance fails reconciliation instead of being silently adopted.
- `POST /machines/<vm>/console/resolve` receives only `{lease_id}`.
- `POST /machines/<vm>/console/open` and `POST /machines/<vm>/console/cancel` receive only `{lease_id, console_id, attempt_id}`. Selected-environment requests continue to carry `X-VM-Environment-Fingerprint`.
- Console responses follow `vm-service/bin/console_sessions.py`'s `Manager._report` and nested `Attempt.report`. Relay validates `schemaVersion: 1`, VM, lease, environment fingerprint, and console identity. Open and cancel must include the matching nested `attempt.attempt_id`.
- Top-level `status` describes the console as `ready` or `revoked`. It never describes launch completion. Resolve returns the latest nested `attempt`, whose separate status is `preparing`, `dispatching`, `launched`, `cancelled`, `closed`, or `failed`.
- Top-level `authentication` is an observation status, while `authentication_mechanism` identifies `private-stdin` or `human-guest-account-prompt`. Nested `attempt.authentication` can be `required` or `unverified`; neither transport connection nor process launch establishes authentication.
- Opening is supported only when `viewer_location` is `service-host`. A remote relay client must not interpret this as a window on its own machine. The existing loopback endpoint restriction is unchanged, and relay adds no tunnel or remote-viewer fallback.

```json
{
  "schemaVersion": 1,
  "vm": "vm-1",
  "lease_id": "lease-1",
  "environment_fingerprint": null,
  "console_id": "console-1",
  "backend": "apple-screen-sharing",
  "status": "ready",
  "reason": null,
  "viewer_location": "service-host",
  "authentication_mechanism": "human-guest-account-prompt",
  "authentication": "unverified",
  "pixels": "unverified",
  "viewer_connected": "unverified",
  "human_confirmation": "unverified",
  "session_binding": "viewer-selection-unverified",
  "server_enforced_view_only": false,
  "readiness_scope": "guest-console-preflight",
  "source": "guest-sharing-controller",
  "observed_at": 1790000000,
  "access_expires_at": 4102444800,
  "attempt": {
    "attempt_id": "watch-1",
    "status": "launched",
    "reason": null,
    "transport_connected": true,
    "viewer_cleanup": "not-started",
    "authentication": "required",
    "viewer_connected": "unverified",
    "human_confirmation": "unverified"
  }
}
```

- Observation strings are bounded identifier tokens, not arbitrary logs or messages. Relay allowlists these fields and drops endpoint, credential, port, and private-path fields rather than retaining a raw console response. Unknown or unrecognized values remain unknown where the value cannot be parsed.
- `observed_at` and `access_expires_at` are finite numeric backend timestamps. The ordinary lease `ttl_expires_at` remains Unix seconds and governs the pre-open expiry check.
- Nested attempt status, `attempt.transport_connected`, authentication, viewer connection, pixels, and human confirmation are independent observations. None inherits success from `status: ready`, a launched process, or an RFB banner.
- macOS requires the human to choose Standard sharing of the existing console, not a separate Log In session or High Performance display. Relay never automatically confirms that selection. `session_binding: viewer-selection-unverified` and `server_enforced_view_only: false` remain visible through discovery, acquisition, resolution, opening, cancellation, duplicate-open responses, and status inspection.
- The JSON fixtures in `tests/fixtures/console-reports.json` are generated by the backend's actual report methods through `generate-console-reports.py`. The regression test compares those fixtures with fresh report-method output without starting a service, lease, guest, transport, or viewer.
- Console HTTP errors retain HTTP status but suppress upstream response bodies that might contain connection material. They require explicit resolution after an uncertain mutation and are never automatically retried.

## Ownership and recovery

- The manager persists an uncertain attempt before dispatch and records the non-secret result after acknowledgement. Failures retain the lease and the attempt identity.
- Restoration reconciles the lease but never replays console opening. A revoked console in the lease replaces retained readiness. If resolve fails after controller loss, retained console status becomes unknown rather than remaining ready. Explicit resolve refreshes the console observation; retained observations are not proof of current connectivity.
- Repeating the current attempt's open resolves status without resending its launch. A historical attempt ID cannot launch again. A new attempt requires the previous nested attempt to resolve as `cancelled`, `closed`, or `failed`, while the console remains `ready`. The relay preserves the complete nested observation on duplicate-open responses and keeps its local attempt record separately as `retainedAttempt`.
- Backend idempotency remains mandatory. It must record an attempt before launch and make cancellation before dispatch terminal so a delayed request cannot open a viewer.
- Cancelling a different attempt while the retained attempt is active or uncertain is refused. Cancellation with no retained attempt is supported for the backend's cancel-before-open contract.
- Opening refuses expired or non-running leases, stale IDs, unknown viewer location, and unresolved prior attempts. A legacy or non-VNC lease is never restarted or retrofitted automatically.
- Closing the viewer or cancelling it never releases ownership. Explicit `finish` and `release` use the normal service release path; machine-service owns revocation before destruction. Its independent worker enforces ordered renewal grants and a monotonic deadline, including controller loss, without waiting for guest-operation locks. These component-tested mechanisms still require live expiry and restart acceptance.
- Relay does not claim that stopping a viewer proves revocation or destruction. `viewer_cleanup: local-children-stopped` covers owned local processes, not Apple's GUI app or the guest's built-in sharing daemon. Managed-stream closure does not revoke guest accounts or contain trusted guest administrators.
- If observation is required, the agent must stop before guest application work until the required viewing is established. A usable viewer does not repair missing or black relay snapshots.
