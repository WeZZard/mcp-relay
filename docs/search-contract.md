# Application search integration contract — working draft

- This contract includes the 2026-09-16 target layout and application-test-plan revision. It does not claim that the migration or new acceptance tests are implemented.
- The parent [technical design](technical-design.md#41-data-ownership-and-inventory-extraction) defines the agreed storage requirements.
- The [implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md) coordinates changes across pilot-images, vm-service, and pi-vm-relay.

## Image-first inventory and backend API

- Provision and install software before extracting its installed state. Declarations and test plans are not substitutes for observed inventory.
- Each application deliberately added by image provisioning uses a shared baseline for basic availability and startup, with separate application-specific extensions when deeper checks are needed. The catalog may also list unchanged OS software, but that does not add it to acceptance selection. Image acceptance runs the composed plans on a fresh clone before promotion through the execution environment used by vm-service and relay.
- Keep application configuration and extensions under `applications/<application-id>/`. Detailed checks for one application must not change the shared baseline or other applications' tests.
- The 2026-09-16 decision supersedes the earlier exclusion of per-application tests.
- Search remains read-only. It does not launch applications, execute acceptance tests, install software, or add certification badges to its results.

A Python 3 collector in pilot-images reads installed state using Linux dpkg/snap,
macOS application-bundle metadata/Homebrew, and global npm metadata where present.
It never installs software or launches GUI applications. Collector coverage is
explicit; manually copied binaries outside these sources are not exhaustively
inventoried. A missing optional manager is recorded as unavailable; a present
manager that fails is an extraction error, not an empty source. Required native
sources (dpkg on Ubuntu, application directories on macOS) must succeed.

Maintainer-editable, version-controlled name/alias mappings normalize source
identifiers (for example a Firefox snap and Firefox app bundle) to a common
application identity. Mappings cannot create installations. Unmapped source
records retain stable source-qualified IDs and observed names. Conflicting
versions for mapped duplicates fail extraction rather than silently choosing one.

### Target inventory layout and association

- Store Git-visible observations in `pilot-images/images/<image>/applications.json`. Use `images`, not `lines`, for the target directory name.
- Keep the closed inventory document `{schemaVersion:1,image,inventory,provenance}`. The `inventory` field contains the unchanged validated collector object.
- Keep closed provenance `{extractionMode,evidenceId,rawSha256,collectorSha256,aliasesSha256}`. The extraction mode is `disposable-clone`, `work`, or `base-maintenance`. The evidence ID matches `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`, and hashes are lowercase 64-character hexadecimal SHA-256 values.
- Keep the extractor and alias mappings version-controlled. Neither aliases nor test plans may invent an installation.
- Keep a separate host-specific association document `{schemaVersion:2,image,base,inventorySha256}`. It is a JSON record, not a symbolic link.
- Store associations in a shared configured local state directory outside the repository. Default to `$XDG_STATE_HOME/pilot-images` when set, or `~/.local/state/pilot-images` otherwise. The producer and reader use the same location.
- Separate published associations from per-build temporary files, and identify published records by image and local image-store identity.
- The association hashes the complete inventory bytes rather than a reserialized object. Its base metadata records the canonical path, file identity, size, and modification metadata of the local image files.
- This metadata detects staleness under the trusted local maintainer model. It is not an image-content hash or tamper-proof attestation.
- The current implementation uses `inventories/<image>.json` plus `inventories/local/base/<image>.json`, and uses `inventories/local/work/` and `inventories/local/pending/` during builds. These paths describe the existing deployment, not the revised layout.
- Rename the configuration tree from `lines/` to `images/` and coordinate publisher, reader, configuration discovery, test, and instruction changes. Keep image identifiers and Tart base-VM names unchanged.
- Prepare deployment and rollback together. Do not move files in only one repository while leaving the backend pointed at the old location or keep competing authoritative directories.
- Image publication must generate and validate both documents. Missing associations must not be repaired by blindly binding historical inventory to the current image.
- A renamed, replaced, or modified base requires validated inventory association. Promotion verifies the work digest and image metadata before rename and the selected image identity afterward.
- Publish the inventory first and the association last using atomic writes and pre/post checks. Invalidate associations before image mutation or refresh, and fail publication if the image changes during association.
- Keep host-specific associations and raw extraction artifacts out of portable version-controlled facts. Their absence after a Git checkout must produce an actionable publication diagnostic, not a misleading empty search result.

### Publication and read-only API

Integrate post-install extraction into build completion and controlled refresh.
Promotion carries the extracted inventory into the base association only after
stopping the work image. Invalidate the old association before refresh changes the
base. Do not execute these maintenance scripts against current golden images as
part of development. Existing bases can be inventoried through dedicated service
clones without modifying the originals; retain base fingerprints before/after
that extraction to establish unchanged origin.

Add read-only `GET /applications` to vm-service. Return a complete envelope:
`{schemaVersion:1, images:[{image, os, architecture, applications:[{id, name,
aliases, version}]}]}`. Load image-associated inventory from the configured
`PILOT_REPO`, never a second extension-owned list. Read bounded, safe closed pairs;
validate exact digest, image, OS and fingerprint, then recheck pair bytes and
fingerprint for ordinary concurrent replacement. Missing pair or digest mismatch
excludes, malformed existing members error even when the other is missing.
Missing inventory, association, or base files exclude that image with backend diagnostics naming the image and exact expected path. Changed image metadata excludes the image with a specific staleness diagnostic. Malformed existing inventory is an HTTP error. If no inventories are usable, return an explicit
catalog-unavailable error rather than silently reporting no matches. An image
with a successfully extracted empty inventory is still a usable inventory.

- The current daemon reads `lines/*/line.conf` through the existing configuration parser. The migration changes discovery to `images/*/line.conf`, alongside `images/<image>/applications.json`.
- Update daemon configuration discovery and image publication together. Requests must not guess between competing old and new sources.

Trusted daemon startup executes the selected image configurations via the existing parser, strictly and without lifecycle discovery's permissive fallback. This happens only after acquiring `daemon.lock`, before HTTP server
construction or GC. All image-to-`{kind, base_vm}` associations must validate;
parse errors/timeouts, enumeration failures, no lines, or invalid associations
publish no snapshot. Known configuration failures leave the daemon available
but `/applications` returns 503 without retrying setup. Unexpected programming
errors propagate. The detached snapshot contains no credentials and shares no
mutable objects with the lifecycle discovery cache.

Association changes (including new/removed lines, base names and OS) require a
daemon restart; requests never initialize or refresh configuration, even with a
cold lifecycle cache. Inventory documents and base fingerprints are still read
live on every request: inventory publication and base staleness are not cached
until restart. Restart/deployment is a separate operator action, not performed
by this implementation.

The endpoint performs host metadata reads only, never shell/config execution,
lease-state writes, boot, SSH, installation or inventory generation. Return the whole catalog or an error:
4 MiB maximum UTF-8 response, at most 64 images and 20,000 installation records.
Fields are bounded: IDs/image keys 128 characters, names/aliases 256, at most
16 aliases per application, versions 256. Text bounds count Unicode scalar
codepoints, not UTF-16 code units or UTF-8 bytes. Metadata text (application
ID/name/alias/non-null version, source ID, timestamp and base path) must be a
nonempty Unicode scalar string: reject C0 controls U+0000–U+001F and surrogate
codepoints U+D800–U+DFFF. At least one scalar must be outside this exact
ECMAScript whitespace set: U+0009–U+000D, U+0020, U+00A0, U+1680,
U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
Do not use language-dependent `strip`, `isspace`, or whitespace regex classes
to define blankness. Thus FEFF-only text is blank; NEL (U+0085) is not blank
and is allowed, as are other C1 controls. Internal/leading/trailing whitespace
is preserved, not trimmed; C0 controls remain forbidden even within nonblank
text. Valid supplementary scalars count once; no normalization is performed.
Image/base keys retain their stricter ASCII grammar; OS/architecture/status
and timestamps retain their additional format constraints. Source command/root
provenance is deliberately separate and unchanged: nonempty scalar strings of
at most 4096 codepoints, NUL forbidden, other controls and blank-only strings
allowed (commands may contain literal tabs/newlines).
Unknown fields and invalid OS/architecture
are errors. These bounds cap parsing/matching work; there is no backend partial
success or hidden pagination. The extension validates the envelope independently
and applies matching and public response limits below.

## Every instance

- This contract was written when the relay and machine-service ran on one Mac, so the relay asked only its loopback instance. A Mac may now run an instance that offers nothing (machine-service DC-93), and that instance's empty catalog must never stand for the network's.
- relay_search asks every instance that discovery finds, or the one `instance` names, and matches each instance's catalog on its own by the rules below. Each installation names the instances that offer it, with their `machine_id` and catalog `generation`, and the result lists every instance asked; an instance that did not answer is listed as unreachable, never left out. An installation whose facts differ between instances is listed once for each set of facts, instead of being a conflict. The search is an error only when no instance answered with a valid catalog ([instances.md §3](instances.md#3-questions-dc-7x-fed-2-dc-7x-fed-3), machine-service FD-7).
- The response budget below counts the whole result, with the instance lists.

## Response budget

The extension returns at most **100 installation records** across application
groups, additionally bounded by **50,000 UTF-8 bytes** and **1,900 lines** of
`JSON.stringify(result, null, 2)`. These conservative bounds include the envelope
and the `truncated` boolean and fit the tool renderer's 51,200-byte / 2,000-line
limits without generic spill-file truncation.

Sort and deduplicate all eligible records before taking a prefix. Budget each
candidate with `truncated: false` (one byte longer than `true`). Stop before the
first record that exceeds a bound; preserve a prefix of complete installations,
never empty application groups. Determine truncation by actual eligible records
omitted, not by reaching the record count. A first record that cannot fit yields
an empty result with `truncated: true`, never invalid JSON. Metadata validation
will bound individual fields independently.

No backend silent truncation is acceptable. A catalog exceeding its transport or
validation limit is an explicit error, not a partial catalog presented as complete.
The backend transport and metadata bounds are defined above.

## Matching

- Matching and public response limits remain the extension's responsibility. The backend provides the validated application catalog; the inventory-path migration does not move matching to the backend.

Trim query whitespace and use locale-independent Unicode lowercase (`toLowerCase`)
for names/aliases and query. No fuzzy matching, Unicode normalization or diacritic
folding is implied. Best match wins: exact, prefix, substring. Filter installations
by OS before grouping, then tie-break using lowercase canonical name, original
canonical name and stable application ID in code-point order. Installations sort
by image identifier. Duplicate alias hits do not duplicate applications. Identical
installation facts deduplicate; conflicting facts for one application/image pair
are malformed catalog data, not an arbitrary winner.

## Diagnostics

Successful and failed searches receive a UUID request ID and one private JSON
record under `<session-state-root>/search-diagnostics/<UTC timestamp>-<UUID>.json`.
The request ID is passed from the tool execution when available as a separate
`toolCallId`, not used for replay or deduplication. No diagnostic ID is added to
the public search result schema.

Record version, UUID, optional tool call ID, UTC timestamp, normalized query/OS,
result status, catalog identity if provided, returned application/installation
counts, serialized byte/line counts, `truncated` on success, and SHA-256 of the
exact serialized public result. Failed records use a fixed allowlisted diagnostic message, not arbitrary upstream
error text, and no success/truncation claim. The original error remains a tool
failure rather than being copied into retained diagnostics. Never store credentials
or guest contents. Query names use the same trim/lowercase normalization as matching.
Validate the closed success/error record schema before retaining or pruning records;
incomplete or extended records are errors, not deletion candidates.

Serialize writes/pruning with the existing session operation queue, without
calling enclosure initialization, recovery or guest APIs. Create only the private
diagnostics directory and records. Refuse symlink paths and insecure directory
permissions rather than changing them. Write records atomically. Each record is
bounded at 16 KiB. Retain at most 256 records and at most 30 days per session,
pruning on each write; this is not a background global retention service. Timestamp
ties among existing records use UUID ordering. The incoming record is always
retained; eviction orders existing records by timestamp then UUID. On wall-clock
rollback, the incoming record is still retained and age expiry uses the current
write time; future-dated existing records remain subject to the count limit. This
is not globally oldest-first ordering across the incoming record and existing
records. Reject unrecognized entries rather than deleting them.

A diagnostic storage failure is explicit: fail the search tool call instead of
silently claiming retained diagnostics. Existing enclosure state must remain
unchanged even when discovery or diagnostic persistence fails. Diagnostics live
outside sealed execution packages and do not create lifecycle/ownership records.

## Acceptance additions

Test exact 100-record fit versus 101 matches, byte/line thresholds, oversized first
record, Unicode/escaping serialization sizes, partial installation groups, OS
filtering before truncation and conflicting duplicate records. Test correlated
success/error diagnostics, both retention bounds, tampering/symlinks, storage
failure and unchanged active enclosure state.

### Acceptance for the 2026-09-16 revision

- Verify that the image publisher and backend reader use the same target inventory and association paths.
- Test a missing inventory, a missing association, a mismatched inventory digest, and changed image metadata separately. Each diagnostic must identify the affected image and missing path or mismatch without exposing secrets.
- Test migration from a checkout that has portable inventories but no ignored local associations. Do not make search silently generate replacement associations.
- Run the explicitly selected provisioned-application plans on a fresh clone. Required failures or missing plans prevent promotion; unrelated OS catalog entries do not expand the plan. Verify that image-level and no-secrets checks remain required.
- Verify that tests execute in relay's actual non-interactive environment and do not conceal missing prerequisites through manual repairs.
- Verify that search itself still performs no guest operations or acceptance tests and that successful inventory extraction is not reported as successful application acceptance.
