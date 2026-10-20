# Selected VM environments

## Purpose and boundaries

- A selected environment binds the machine-service endpoint, image repository, Tart image store, and mutable state directories into one validated startup configuration.
- A Git worktree isolates source files, not virtual disks. A worktree is optional; a separate Tart store and separate mutable state are required for an isolated environment.
- The feature does not copy VM disks, create worktrees, start a service, or replace production merely because a profile is loaded.
- Hardware capacity remains shared. In particular, separate stores do not create additional macOS virtualization slots.

## Configuration

- Set `VM_ENVIRONMENT_FILE` before starting Pi, machine-service, or an image-maintenance command. The backend CLI also accepts `--environment FILE` before its subcommand, which overrides the ambient selector.
- A selected profile is authoritative over the older individual environment variables. An invalid explicit selection fails; it never falls back to production settings.
- Without a profile, existing legacy configuration remains supported. Use profiles when endpoint and store isolation must be enforced together.
- The profile contains only the following fields. Replace the example absolute paths with real paths; the repository must contain `images/`, and both executable paths must exist and be executable.

```json
{
  "schemaVersion": 2,
  "id": "image-test",
  "vmServiceUrl": "http://127.0.0.1:6249",
  "imageRepository": "/absolute/path/to/pilot-images",
  "tartHome": "/absolute/path/to/vm-environments/image-test/tart",
  "serviceStateDir": "/absolute/path/to/vm-environments/image-test/service",
  "imageStateDir": "/absolute/path/to/vm-environments/image-test/images",
  "relayStateDir": "/absolute/path/to/vm-environments/image-test/relay",
  "machctlPath": "/absolute/path/to/machine-service/bin/machctl",
  "tartPath": "/absolute/path/to/tart"
}
```

- The profile is at `schemaVersion` 2, which names the CLI `machctlPath` (machine-service DC-41, DC-42). A profile at `schemaVersion` 1, or one that carries `vmctlPath`, is from before the machine-service rename and is refused with an error that names `machctlPath` and `schemaVersion` 2. The relay never reads `vmctlPath` and never rewrites a profile, because profiles are the operator's own files (DC-27).
- The bundle exported to subprocesses uses machine-service's names: `MACHINE_SERVICE_STATE`, `MACHINE_SERVICE_HOST`, `MACHINE_SERVICE_PORT` and `MACHCTL`. `VM_ENVIRONMENT_FILE`, `VM_ENVIRONMENT_FINGERPRINT`, `VM_RELAY_STATE_DIR`, `VM_RELAY_URL`, `PILOT_REPO`, `TART_HOME`, `PILOT_IMAGES_STATE_DIR` and `TART` keep their names, and so does the profile's `vmServiceUrl` field.
- The four mutable roots must be disjoint from one another, the image repository, and the legacy default store/state roots. Canonical paths are checked so existing symlinks cannot disguise overlaps.
- Profile loading is read-only. Mutable roots may be absent until the owning operation initializes them; no seed image or association is fabricated automatically.
- JSON duplicate keys, unknown fields, invalid Unicode paths, dangling symlinks, and non-loopback endpoints are rejected. The endpoint requires HTTP and an explicit port.
- The identity fingerprint is SHA-256 of the canonical profile encoded as compact, key-sorted UTF-8 JSON. This is configuration identity, not a secret or an authentication mechanism.

## Dependency injection and ownership

- `RelayManager` depends on the `VmBackend` protocol and an immutable selected-environment object. The front end (the MCP server here, formerly pi-vm-relay's Pi extension) constructs them at startup; model tool calls cannot select a different backend per operation.
- machine-service constructs its selected configuration and Tart execution context before serving requests. Image configuration is validated and its selection is fixed for that daemon's lifetime.
- Image tooling resolves configuration through the profile's explicit trusted `machctlPath`, checks that the selected repository is the checkout containing the invoked script, and uses the selected Tart and machctl executables.
- The bootstrap exports only routing and state variables. It also exports `VM_ENVIRONMENT_FINGERPRINT` so a subprocess command sequence refuses a profile changed midway through that sequence. An explicit backend CLI selector starts a new selection rather than silently modifying an existing lease.
- The backend reports its environment identity through `/health`. Selected requests carry `X-VM-Environment-Fingerprint`, and a mismatch is rejected before mutation. The client verifies identity before lease operations, and that `/health` answers `"service": "machine-service"` (DC-27).
- Service state and the Tart store retain identity markers. A store-scoped daemon lock prevents another selected service from taking over the same store, even through another state directory or port.
- Relay leases retain endpoint, store, and profile binding. Restoring a lease under a different environment fails before backend operations; the original ownership record remains intact.
- Destruction verification executes the selected Tart binary with the selected `TART_HOME`. It does not inspect the default host store and infer that a VM elsewhere has disappeared.
- This isolation does not replace host permissions or protect against arbitrary manual commands by the same OS user. The image maintenance lock still coordinates source-image changes, and backend fingerprints are not remote authentication credentials.

## Usage and activation

```sh
# Resolve configuration without a service request or VM allocation.
/path/to/machine-service/bin/machctl --environment /path/to/environment.json environment --json

# Start a separately configured service only when operationally authorized.
/path/to/machine-service/bin/machine-service --environment /path/to/environment.json

# Start a Pi session against that environment.
VM_ENVIRONMENT_FILE=/path/to/environment.json pi

# Invoke maintenance from the selected image checkout.
VM_ENVIRONMENT_FILE=/path/to/environment.json \
  python3 /selected/pilot-images/host/check-clone.py ubuntu2404 --source work
```

- Use another loopback port for a test service so the running production service need not be replaced.
- Populate the selected store through an explicit image import or build. Do not share writable disks through hard links or substitute production association records; associations belong to the actual local store.
- Do not edit an active profile to redirect retained leases. Finish or release its leases, stop the service, and select a separate environment for the next task.
- Mismatched store/state markers require deliberate operator reconciliation. Neither startup nor configuration resolution overwrites them to make a changed profile appear compatible.
- A backend or image repository can be replaced at the composition boundary without adding a new model-facing tool or a hypervisor plugin framework.

## Verification

- Resolver tests check canonical paths, disjoint roots, closed profile fields, stable fingerprints, and read-only behavior.
- Cross-repository tests compare the TypeScript resolver, Python backend resolver, and actual image bootstrap against the same profiles.
- HTTP tests use an executable fake Tart to verify that acquisition, boot dispatch, stop, and deletion use the selected store and reject wrong fingerprints.
- Relay tests retain a clone in the selected store while a different ambient store appears empty, and verify that release refuses to claim destruction until the selected store confirms absence.
- These checks do not constitute live image acceptance, VM disk migration, or production activation.
