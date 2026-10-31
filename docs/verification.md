# Implementation verification

## Background download of step evidence (2026-10-08)

- Scope: [screenshot-delivery.md §10](screenshot-delivery.md#10-background-download-of-step-evidence), decisions DC-9 to DC-11, built on `f227cef` (v0.9.0) in the `evidence-download` worktree. This is a working-tree implementation, not a released revision.
- `npm run build`, `npx tsc --noEmit` and `npm test` passed: 451 tests, 446 passed, 3 skipped for missing sibling checkouts, 2 todo, none failed. The tests use the loopback fake VM service.
- The relay's macOS live check passed against the vm-service test instance on port 6250: `MCP_VM_RELAY_URL=http://localhost:6250 node scripts/live-check.mjs scripts/live-checks/macos.json test-evidence/<run>`. Ten step downloads of about 16 MB each took about 0.3 s each; at finish, the `relay-run` extraction took all ten result files from the host, the state pull took 60 of its 61 files from the host, no archive fell back to the per-file pull, and `deliveryVerified` was true. `relay_finish` took 4.2 s.
- The pi-secretary MacArena Reminders case (`4ff150c8`) passed with this build: `scripts/vm-use/macarena-run.ts --open-app --permission-check=online --trace --vm-service=http://localhost:6250 --relay-server=<worktree>/dist/server.mjs`. Its 70 step downloads all ended `downloaded`, each in about 0.3 s with no queue wait. `relay_finish` took 12.7 s and made 58 vm-service requests. The same case on v0.9.0 earlier that day took 98.4 s and 3,282 requests; that run had more steps, but the finish's requests no longer depend on the number of steps: about 17 per pulled tree, plus the one step download in flight.
- During the run, an agent request that arrived while a step download was being served waited for it: 0.11 s at the median, 6.5% of the step interval time (0.14 s and 10.5% for the per-image download of v0.9.0), from pi-secretary's `scripts/vm-use/step-interval-report.py`.
- Not verified: a step download failing on a live link, the guest running out of space for an archive (AD-10), `relay_release` and a recording reset on a live VM, and the Linux guest.

## Lifecycle fixes (2026-09-27)

- The [lifecycle fixes](lifecycle-fixes.md) R1 to R6 were each preceded by a reproducer test that failed on the 0.6.1 source for the stated reason, on branch `WeZZard/lifecycle-reproducers`.
- The final `npm run check` passed its build, typecheck and test suite. The Node test runner reported 419 tests: 413 passed, zero failed, three were skipped and three were marked todo.
- The three skipped tests need sibling `pilot-images` or `vm-service` checkouts, which were absent. The three todo tests document behavior that waits for the owner's decision (R3 session identity, R7 and R8).
- The tests used fake vm-service instances, a closed port and temporary state, registry, project and home directories. No VM, live vm-service, Tart, `vmctl` or user state was used, and the headless end-to-end suite was not run.

## Console and screenshot merge verification (2026-09-21)

- The merge preserves local console commits `6e555c0` and `a5092b2` alongside remote screenshot-delivery commit `cb31161`. The tool exposes thirteen actions, including all console actions and `image`. Generated `dist/` files were rebuilt from the merged source rather than selected from either parent.
- The final `npm run check` passed its build, typecheck, and complete test suite. The Node test runner reported 457 tests, 457 passes, zero failures, and zero skips. Counts in this section use the runner's `tests`, `pass`, `fail`, and `skipped` totals.
- The isolated real Pi RPC smoke passed before and after reload with all thirteen actions, closed image selectors, and action-specific reason requirements. The isolated Git-install smoke passed without a consumer build or sibling SDK checkout and verified both image and console schema branches in the installed bundle. These checks did not modify the user's installed extension or settings.
- The initial RPC smoke exposed missing console action names in the prompt snippet. The corrected snippet and a new extension assertion now cover every action. Both initial full checks reported 456 passes and one helper-death startup timeout out of 457 tests. Focused runs also reproduced executable-fixture startup timeouts. Only the two helper-crash tests now use an explicit five-second startup allowance, matching the existing cross-process worker allowance; production retains its two-second default and the short-deadline and cancellation tests remain unchanged. The final focused owner-lock and extension run passed all 25 tests before the full check.
- Local logs and isolated smoke artifacts are retained under `test-evidence/merge-20260921/`, including the initial failures. Existing smoke evidence directories were preserved and restored. The [merge plan](../.plans/2026-09-21-console-screenshot-merge.md) records the integration and fixture-startup investigation.
- No live VM, viewer, model API, service configuration, or sibling repository was changed. These passing automated gates supersede the pre-merge suite status for this merged checkout, not the pending live acceptance, gateway inspection, or human confirmation requirements below.

## Configuration and native-client experiment (2026-09-21)

- Subsequent authorized provisioning installed TurboVNC Viewer 3.3.1 ARM64, enabled the persistent console configuration, and restarted vm-service through its guarded installer while no leases existed. Read-only discovery then reported both backends configured; this supersedes the unavailable-configuration observation below without establishing guest readiness.
- Disposable Linux and macOS clones booted with unmodified Tart 2.32.1. Linux prerequisites were installed on a stopped, unpromoted candidate. macOS sharing and filtering preparation remains incomplete. The provisioning handoff is local to the sibling image repository at `.handoff/2026-09-21-console-provisioning.md`.
- A separate real Apple Screen Sharing 7.0 to Linux prototype verified retrieval of a newly generated temporary password staged through Security.framework. The client still required a nonsecret Sign In click; launching the bare VNC URL did not authenticate unattended. Actual viewer screenshots showed the randomized existing guest desktop, and credential deletion, stream revocation, and disposable-VM cleanup were checked.
- That experiment did not exercise the installed relay workflow, a macOS guest, a locked keychain, or human confirmation. Its local report is `.handoff/2026-09-21-apple-native-credential-verification.md`, with ignored evidence under `test-evidence/apple-native-20260921/`. These local files are not part of this committed verification record.
- Two Linux guest-adapter compatibility fixes and their regression tests remain separate changes in vm-service. The experiment's focused backend run reported 98 passing tests; this is not a relay full-suite or normal viewer-integration acceptance result.
- The user selected TurboVNC for the automated path to avoid interactive Keychain dependencies. The existing Linux integration already uses private stdin password delivery. Apple viewing of macOS remains the current implemented path; a TurboVNC replacement for that guest family is not implemented or verified by this decision.
- Installed Pi reload and complete relay-driven platform acceptance remain outstanding. The historical capture disagreement is not resolved by comparing prototype viewer images with independent guest captures.

## Console rollout status

- The documentation reconciliation inspected local relay commit `6e555c0` and backend commit `7aea50f`. Both contain the stock-Tart guest-console implementation. The component-test results below remain historical test evidence; no tests, service commands, VM operations, or viewer launches were rerun for this documentation-only update.
- The task's prior operational report states that vm-service was restarted, the default console configuration was absent, and a read-only live capability query reported both Linux and macOS unavailable because console configuration or a viewer was missing. This update did not repeat that query or independently inspect deployed process identity.
- Pi had not been reloaded according to that report. Current checkout source and generated bundles therefore do not establish that the running Pi session exposes the new actions.
- Configuration enablement, trusted viewer availability, guest preparation, and installed-service/relay identity still need authorized verification. A restarted service is not enabled sharing or a live viewing pass.
- Linux and macOS live acceptance remain pending, including stock-Tart boot, real authentication, changing viewer-side pixels, matching relay captures, human confirmation, isolation, expiry during guest work, controller loss, cancellation, and verified cleanup. Follow [Technical design Section 3.8](technical-design.md#38-live-viewing-of-the-owned-vm) and [the backend acceptance specification](../../vm-service/docs/vnc-acceptance.md).
- The historical black desktop/browser-capture disagreement remains unresolved. Neither component tests nor configuration discovery establish that it is repaired.

## Backend nested console report integration

- Relay now consumes the actual `Manager._report` and nested `Attempt.report` schema from `vm-service/bin/console_sessions.py`. It no longer infers attempt status from top-level console readiness.
- `tests/fixtures/generate-console-reports.py` produces the checked-in `console-reports.json` by calling those report methods without starting a service, allocating a lease, or launching a viewer. Tests compare fresh generated reports with the fixture and verify that the projection preserves every declared report field.
- Authentication status and mechanism are separate. macOS session-selection uncertainty, lack of server-enforced view-only access, unverified pixels, and unverified human confirmation remain present in discovery, acquisition, console operations, duplicate-open results, and status inspection.
- Regression tests cover nested terminal-attempt reconciliation, revoked console records after restart, controller-loss errors, schema version checks, and restoration without launch replay.
- Build and typecheck passed. The first full run reported 311 passed cases and one timeout in the unchanged owner-lock helper-death test. The focused owner-lock and console rerun passed all 30 cases. The final full rerun passed all 312 cases, with no failures. These counts use the Node test runner's `tests` total.
- Logs are retained as `test-evidence/console-consumer/nested-report-tests.log`, `nested-report-focused.log`, and `nested-report-tests-rerun.log`. The initial failed run is retained rather than replaced by the passing rerun.
- During this component-test work, no vm-service source was modified, and no live console acceptance, deployment, extension reload, service restart, or commit was performed. Later reported rollout observations are recorded above.

## Unmodified-Tart console consumer tests

- Relay now implements the consumer API described in [the console contract](console.md). The backend implementation, installed environment, and real viewer remain separate acceptance dependencies.
- The final `npm run build`, `npm run typecheck`, and `npm test` passed. The full Node test runner reported 307 passed cases and no failures; this count is the runner's `tests` total, not a live acceptance count.
- Regression cases verify environment-binding refusal, immutable lease replacement, explicit `vnc: false`, refusal to retrofit non-VNC leases, cancellation before opening, and environment fingerprint headers. An earlier focused console, extension, and provider-schema run also passed; the final full run covers the completed source.
- Tests cover the closed new actions, old non-VNC acquisition, no automatic viewer opening, independent unknown observations, secret-field filtering, exact HTTP request bodies, uncertain-attempt restoration without replay, and cancellation without VM release.
- The RPC smoke assertions were updated for the new schema, but that script was not run because extension reload was outside this task's authorization. Installation testing was also not run.
- Logs are retained under `test-evidence/console-consumer/`. No deployment, service restart, extension reload, live VM/viewer action, or Git commit was performed. These results do not establish authentication, displayed pixels, access revocation, or human confirmation.

## Historical live viewer investigation (2026-09-20)

- This investigation predates the implemented console contract. Its missing-API conclusion and implementation blockers are superseded by the console integration sections above; its original findings and test outcomes remain historical evidence.
- Implementation was authorized, but the backend source inspected at that time had no supported secure console discovery/opening contract. The dependency and material review decisions are recorded in [the investigation report](live-view-investigation.md) and the vm-service owner handoff.
- `npm run check` built and typechecked successfully, then reported 292 passing tests and one failure out of 293 runner-reported tests. The failure was a JSON parsing error in the interrupted-browser-start fixture's event reader. The focused browser suite passed on rerun; the aggregate failure remains recorded.
- `npm run test:install` passed its isolated Pi Git-install, registration, and reload checks. Rebuilding did not change tracked bundles.
- Logs are retained under `test-evidence/live-view-investigation/`. These checks are baseline regression evidence, not viewer-feature acceptance.
- The original black desktop snapshot and rendered browser capture were inspected without modification. Their disagreement remains unresolved.
- This investigation created no VM, viewer, access grant, production change, or human visibility confirmation. Feature implementation and security tests were pending at that time; later component results are recorded above. Isolated live acceptance and manual confirmation remain pending.

## Screenshot-delivery implementation (2026-09-21)

- The user approved implementation of the [screenshot-delivery contract](screenshot-delivery.md) in the isolated `screenshot-delivery` worktree. Source and rebuilt bundles now expose the nine-action schema, typed final image results, owner-bound recovery, bounded presentation, and conflict-preserving finalization. This is a working-tree implementation, not a deployment or released-revision claim.
- `npm run build`, `npm run typecheck`, `node scripts/pi-rpc-smoke.mjs`, and `npm run test:install` passed. The install smoke used an isolated local Git mirror and temporary Pi home; it did not modify the user's installed extension.
- The [full automated suite](../.plans/screenshot-delivery-implementation-evidence/full-suite.tap) ran 438 tests: 435 passed, two failed, and one was skipped. The failures are missing external fixtures: `test-evidence/ubuntu-20260912-2127` and the sibling `pilot-images/inventory/collect.py`. The complete suite is therefore not green, and its verification gate remains open.
- The [earlier integration run](../.plans/screenshot-delivery-implementation-evidence/integration.tap) passed all 90 manager and image tests present at that checkpoint. The later full run includes the added guest-journal cases. Tests use a loopback fake VM service and local files, not a live VM.
- Real Pi SDK 0.85.1 tests cover final images, native error flags, session persistence, subsequent model context, blocked images, and non-vision adapter behavior. Four provider adapters were exercised without API requests. Serialization success does not establish gateway acceptance or model inspection.
- Recovery tests cover immutable associations, foreign references, unsafe paths, shared transfer budgets, unchanged hashes, offline reload, recording resets, journal-backed partial captures, and canonical snapshot restoration before finalization. Application-image retrieval exports only the selected declared member. Normal finalization exports the consumer declaration once.
- The presentation implementation uses Pi's public `resizeImage` export. Originals are limited to 64 MiB, 40 million pixels, and a maximum dimension of 32,768. Presentation images are limited to 2,000 × 2,000 pixels and 4 MiB of base64 payload. Metadata and capture-journal retrieval are limited to 4 MiB. Every image operation shares one 90-second deadline and three byte-transfer attempts, including metadata transfers.
- No live Discord run, VM acquisition, installed-plugin modification, consumer integration, commit, or push occurred. A read-only host probe found no owned VM; no enclosure was acquired. Actual agentic inspection, isolated-VM finalization and destruction, the affected gateway, and human review remain unverified. The separate black-display mismatch remains unresolved.

## Screenshot-delivery investigation (2026-09-21)

- This section retains the pre-implementation investigation. At that checkpoint, the documentation request authorized design work only; the later implementation authorization and results are recorded above.
- The baseline is Relay revision `e077367427e6a46a39039434725881c21a979e3e`. Source tracing found that the receiver saves screenshots, the execution transport retrieves only JSON receipts, and the native tool returns text-only content.
- The [controlled receiver/serializer diagnosis](../.plans/screenshot-delivery-evidence/current-contract.json) reproduced four saved originals with four text-only command results. The fixture uses a constant one-pixel image and a stubbed manager at the serializer boundary. It proves protocol behavior, not visual rendering or a complete manager session.
- The [offline provider diagnosis](../.plans/screenshot-delivery-evidence/provider-images.json) passed eight cases across four Pi AI 0.85.1 adapters, covering normal and error tool-result messages. Image data remained in each captured payload, and the fetch guard observed zero API requests. This does not prove gateway acceptance or model inspection.
- The selected baseline suite passed 115 tests with no failures, cancellations, or skips. The [TAP log](../.plans/screenshot-delivery-evidence/baseline-tests.tap) covers tool errors, extension registration, transport, transfer, package verification, and manager fixtures. These passing baseline tests do not establish the unimplemented image contract.
- The [investigation plan](../.plans/2026-09-21-screenshot-delivery.md#5-verification-performed) records reproduction commands and dependency provenance. The [SHA-256 manifest](../.plans/screenshot-delivery-evidence/SHA256SUMS) binds the inspected Relay source, committed bundles, and retained diagnostic results.
- The exact affected session's runtime, provider adapter, image settings, and gateway behavior remain unverified. The separate black-display capture issue remains unresolved.
- No live Discord run, VM allocation, installed-plugin modification, historical evidence rewrite, or consumer implementation occurred during this investigation. Existing lifecycle tests used a loopback fixture service, not a real VM.
- Agentic image inspection, live isolated-VM finalization and destruction for the new feature, and human review remain pending. No released Relay revision is claimed to satisfy the screenshot-delivery handoff.

## Staging publication and worktree retirement (2026-09-17)

- Both accepted work images were promoted to bases in the isolated staging Tart store. Published base associations and acceptance receipts were independently verified before retiring the staging service.
- Ubuntu's work and fresh-clone gates were rerun against the final shared runner after promotion correctly rejected an older plan digest. All three publication steps completed successfully; no receipt was rebound to bypass validation.
- The selected staging relay search returned `cua-driver` on `ubuntu2404`, version `0.28.2+pilot1`, Linux ARM64. macOS was discoverable under `Cua Driver`, version `0.12.6`; the hyphenated macOS query had no match because that inventory has no such alias.
- Publication results are retained under `test-evidence/live-isolated-20260916/publication/`. Production-image metadata remained unchanged.
- Published portable inventories were committed as `pilot-images` `9fd76f0939ad3521eccb25ed145077187023a2f1` and fast-forwarded into `main`. All 199 image tests passed before that commit.
- After confirming no leases, the owned staging backend was stopped and both temporary Git worktrees were removed. The production backend remained healthy. Accepted staging VM disks and all original acceptance evidence were retained.
- Source archives and their SHA-256 manifest are under `test-evidence/live-isolated-20260916/retired-sources/`. Historical evidence includes absolute worktree references; the archives preserve those source bytes after removal.
- The retained staging profile still records the retired worktree paths. Restarting staging requires an explicit repository/executable-path and environment-identity migration. No marker, receipt, or profile was silently rebound during cleanup.
- No image was uploaded to an external registry, and production image selection was not changed.

## Live acceptance scope correction

- The owner clarified that application acceptance covers software deliberately added by image provisioning, not all OS packages in the catalog. The catalog remains unchanged and may include inherited software.
- The `pilot-images-live` worktree now uses explicit `scope: "provisioned"` selections with provisioning source references. Reports retain other catalog IDs in `notTestedInventoryIds` without treating them as passed or failed application tests.
- Ubuntu's selection includes common utilities explicitly added in phase 00, browsers, Node/npm/Corepack, socat, Playwright, CuaDriver, Pi, and native Claude Code. Image-configuration and no-secrets checks remain separate mandatory gates.
- Earlier inventory-wide live failure reports remain historical evidence. Their failures are not converted into passes by the scope change; a new scoped run is required.
- The live image fixes were committed as `pilot-images` `b0fa78237511541af3ec6689842d4566033be9d2` and fast-forwarded into its main checkout. The final fixture suite passed all 199 image test cases. Earlier failing runs remain intact; passing scoped work and fresh-clone runs are recorded below. Neither image has been promoted or published.

## Isolated live acceptance completed (2026-09-17)

- Both OS work images passed the automated provisioned-application, image-configuration, and no-secrets gates, followed by acceptance on fresh clones. Ubuntu selected 17 plans; macOS selected 24 plans. Plan count is `len(report.applications)` for each scoped report, not the total installed catalog size.
- Ubuntu's work receipt was produced by extraction 14, and its fresh-clone receipt by attempt 15. Parent verification is retained at `test-evidence/live-isolated-20260916/ubuntu-fresh-15-parent-verification.json`.
- macOS's work receipt was produced by extraction 3, and its fresh-clone receipt by attempt 4. Parent verification is retained at `test-evidence/live-isolated-20260916/macos-fresh-4-parent-verification.json`.
- Real relay recovery passed on Ubuntu attempt 5 and macOS attempt 7. Each sequence ran a successful recorded command, intentionally exited 7, retained the same VM, performed an explicit diagnostic repair, completed another recorded command, delivered verifiable evidence, and explicitly released the clone.
- The recovery packages intentionally report aggregate execution failure because the injected failure remains in history. Snapshot completeness is incomplete because diagnostic commands deliberately have no screenshot evidence. (Superseded on 2026-09-28 by the owner decision "Actionable verdicts": diagnostics no longer make snapshots incomplete, and verdicts are derived at review, so these packages now review with the current rules.) These are not claims that every historical step succeeded, and human review remains pending.
- Passing package roots are `test-evidence/live-isolated-20260916/ubuntu2404-relay-recovery-2026-09-17T01-42-37-466Z/packages/relay-live-recovery-13572cf0/` and `test-evidence/live-isolated-20260916/macos26-relay-recovery-2026-09-17T03-29-03-995Z/packages/relay-live-recovery-d03249cd/`. The parent independently reran package verification and checked exact clone absence in vm-service and the selected Tart store.
- Live fixes include native-session and daemon startup observation, Snap-accessible Firefox profiles, guest-home-aware report validation, removal of test-only PATH changes, exact empty Pi-store handling, source-digest pinning, explicit provisioning scope, and image/no-secrets evidence bound to the stopped source.
- Receiver termination verification now observes asynchronous process-group exit. On macOS `EPERM`, it uses a bounded independent process-table check; denial itself never counts as proof of termination. All 293 relay tests, build/typecheck, Pi RPC and isolated installation checks passed after these changes.
- The backend regression rerun passed 173 unit and 46 integration tests. Final logs are under `test-evidence/live-isolated-20260916/final-tests/`.
- The selected backend has no remaining leases, and both work images and seeds are stopped. Production-image metadata and config/NVRAM hashes match preflight; this is file-metadata/config verification, not a whole-disk hash. Evidence is `test-evidence/live-isolated-20260916/final-host-verification.json`.
- Manual Screen Sharing review, the long idle-duration doctrine check, production promotion, catalog publication, and registry hosting are not claimed. macOS was built using explicitly supplied host Xcode and CuaDriver bundles; this does not establish a self-contained external rebuild.

## Earlier automated verification of the 2026-09-16 design revision

- The [revised design](design.md#recovery-and-image-readiness-revision-2026-09-16) requires agent recovery in the same VM, application test plans, the `images/` inventory layout, configurable execution timeouts, and separate host and guest checks.
- Relay recovery, timeout propagation, explicit diagnostic repair, recording reset, host/guest probe scope, and the rebuilt distribution are implemented in the working tree. This is not a deployment claim; the installed extension and running backend require coordinated activation.
- The final `npm run check` passed all 289 test cases with build and typecheck. The Pi RPC smoke test and isolated Git-install smoke test passed without model calls or VM allocation.
- The backend passed all 173 unit test cases with the real collector configured and all 46 isolated integration test cases. This includes configured work-source cloning, source-fingerprint mismatch rejection, CLI timeout propagation, selected-environment ownership, and HTTP request identity checks. Non-failing ResourceWarnings for subprocess streams remain.
- The image repository passed all 96 fixture test cases. These cover baseline/source adapters, isolated extensions, safe capture archive verification, fresh-work-clone receipts, promotion guards, selected executable/store routing, and a standalone guest verifier without host dependencies.
- Cross-repository tests verified identical canonical profiles and fingerprints across the TypeScript resolver, Python backend resolver, and actual image bootstrap. They also verified that a clone remaining in the selected Tart store cannot be declared destroyed merely because another store is empty.
- Final logs are retained under `test-evidence/selected-environments-2026-09-16/`. Earlier implementation logs remain under `test-evidence/recovery-2026-09-16/`. These tests do not prove live application readiness.
- Both checked-in inventories have complete plan coverage. The number of IDs without a plan is `len(installed IDs − IDs mapped to explicit or native plans)`, which is zero for each image. Source adapters inspect actual package metadata and entry points; a runtime failure still blocks acceptance rather than becoming a pass.
- The official CuaDriver 0.28.2 Linux arm64 archive was downloaded and independently checked against its pinned SHA-256 and ELF architecture without executing the binary on the host. The build now verifies it on both sides of transfer and assembles a local Debian wrapper for dependency installation and inventory. Linux remains an upstream preview build and requires live capture acceptance.
- Fresh-work-clone acceptance is implemented. Promotion requires a passing report tied to the exact stopped work source and current application plans; work-guest or base-clone reports do not substitute for it.
- The tested external changes were committed as `vm-service` `478ba861b67e789fdc1364790326a6775b7ff1e8` and `pilot-images` `9bc4473c385c1b3d67dab5d032a4ebda5b9ca8ff`. Both commits have valid GPG signatures.
- At that earlier checkpoint, no live VM acceptance, golden-image rebuild, or production service activation had been performed. Those operational steps remain separate from committing and publishing code, and are tracked in [the implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md).
- Results below the following heading describe the earlier implementation and remain historical evidence.

## Earlier implementation evidence

The [design overview](design.md) links the [UX specification](ux-design.md) and
[technical contract](technical-design.md). This document separates implemented
guarantees from environment-dependent live acceptance. The specifications include
application search and run-only intent requirements now implemented and fixture-tested;
real inventories are validated and candidate discovery plus fresh selected-image
stage/run/delivery passed. The initial completion rejection concerned Git-ignored
published inventory. Portable observations are now Git-visible and commit-ready,
with separate ignored exact-digest/base associations. Parent reran 29 image tests,
255 relay tests/build/typecheck and eleven candidate cases. Independent review
passed the inventory correction, but the final completion audit identified two
verification gaps: synthetic candidate base associations and an E2E syntax error.
The latter is fixed in authorized vm-service commit `c13c38a`: exact staged-snapshot
full discovery passed (173 discovered, 162 passed, 11 live E2E explicitly skipped).
Log: `test-evidence/backend-full-discovery-parent/vmsvc-parent-full-discovery.log`.
The integrated real-base chain now passed at
`test-evidence/real-base-chain-2026-09-13T21-04-52-286Z/`: actual base publication,
current search driving sole acquisition, immediate inventory equality before support
changes, stage/run/finish/output and cleanup. Parent independently verified427 original
hashes, both PNG decodes, package delivery with no findings, and current cleanup.
See `test-evidence/real-base-parent-verification.md`. NonUI screenshot evidence,
not video/visual responsiveness; human review pending. Final independent goal audit approved. Only vm-service commits (`f11184e`, `c13c38a`) were authorized.
No push or deployment.
Historical gates below do not establish complete conformance to those designs.

## Repeatable gates

```sh
npm run check                  # build, strict TypeScript check, node:test
node scripts/pi-rpc-smoke.mjs   # real installed pi, no model/API calls or VM allocation
```

The automated suite uses real relay-driver SDK/admission/journal/snapshot code.
Its manager integration server implements vm-service's actual HTTP wire format
and launches the built receiver as a subprocess. A test-only CUA executable
writes a constant PNG: these tests prove contracts, **not** actual UI behavior.

## Installability verification

*Historical: this section, `npm run test:install` and `scripts/pi-rpc-smoke.mjs`
above verified pi-vm-relay's own git-based Pi install, which is retired along
with that script and `install-smoke.mjs`; neither was ported to mcp-vm-relay
(see the README). The narrative below is preserved as written.*

Current full gate: **255 tests pass**, plus build and strict typecheck. The
prebuilt distribution loads `dist/index.mjs` and contains its compiled SDK,
receiver/browser, doctor and integrity/provenance records. Runtime manifests
have no sibling `file:` dependency. Pi installs production dependencies without
running a build hook; Pi-owned modules remain external host peers.

`npm run test:install` invokes the real command
`pi install git:github.com/WeZZard/pi-vm-relay` in an isolated HOME/settings
directory. A child-only Git URL rewrite points that exact URL at a temporary
Git mirror of the working tree, without contacting GitHub. It verifies the
installed commit, unchanged bundle bytes, absence of SDK/compiler dependencies,
and startup with the installed source directory removed. It checks the sole
tool, commands, schema, Available tools snippet, portable state and reload. A separate full HTTP fixture test loads the **compiled distribution
entry**, stages its shipped receiver, executes a recorded command and verifies
extraction/package delivery and cleanup. No source manager is substituted for
that compiled entry. These tests make no model or real VM calls. Result and RPC
evidence are under
`test-evidence/git-install-smoke/`. This isolates the plugin's filesystem/configuration;
it does not claim a newly provisioned operating system or VM backend.

Registry/configuration tests cover state-root precedence, Python selection,
explicit registry validation, compatible home registry reuse, private concurrent
managed initialization, foreign-row preservation and cleanup. Existing public
directories are not silently chmodded. Doctor tests cover shipped hashes,
read-only backend inventory, missing assets/service, and malformed registries.
The real doctor passed against the already-configured host/backend; it neither
acquired a VM nor established new guest UI readiness.

Pi Git installation is the supported route; there is no tarball distribution.
The local-mirror test does not establish GitHub authentication or availability
of unpushed changes. Repository visibility remains private; npm publication has
not occurred. See README.md for installation commands, prerequisite information
and private-repository access requirements. Earlier archive-test evidence is retained only
as historical evidence, not as an offered installation method.

## Application search and run-only intent verification

The rebuilt runtime passes **255 tests**, build and typecheck. Search matching,
OS filtering, deduplication/conflicts, whole-installation truncation, diagnostic
retention (30 days and 256 records), unsafe storage and interrupted-lease isolation
are covered by `tests/search*.test.ts`. The vm-service unit suite passes **132 tests**
with `PILOT_INVENTORY_COLLECTOR` pointing at the real collector code, exercised
with fixture command output. Pilot-images passes **27 fixture tests**, including executable shell lifecycle
fixtures and producer/backend compatibility. These are not claims of real image extraction.
The independent search audit resulted in blank-metadata rejection, shared query
normalization, closed retained-diagnostic validation, and fixed-message error
records that do not persist arbitrary upstream error content.
The backend logs excluded stale/missing image metadata without allocating leases.

Real Pi RPC startup/reload and native Git-install smoke passed using the regenerated
bundles. The Git install remains an isolated local-mirror test, not remote GitHub
verification. The implementation registers exactly `relay` with eight `action`
choices. In that historical discovery revision, only `run` accepted `reason`;
the implemented console revision also requires it for `console-open`. Legacy `relay_*` names are absent. The real Pi
RPC test verifies the registered schema, the Available tools system-prompt
snippet and both slash commands before/after reload, without a model call or
VM allocation.

`tests/extension.test.ts` verifies action/kind payload discrimination, rejection
before manager access, reason translation, exact dispatch/signals, same-session
ownership, action headers, output bounds and lifecycle hooks.
`tests/manager.test.ts` exercises the actual new tool definition through the
HTTP fixture and built receiver: acquire, stage, recorded exec/script/code,
checksummed extraction and verified finish, plus explicit release and invalid
input. These tests also check heartbeat activity, registry restoration and
unchanged run `because` values, structured reason-free lifecycle facts, legacy
persisted-state recovery and no leaked `action` discriminator.
As elsewhere in this suite, the fixture captures a constant PNG; it does not
claim fresh visual acceptance. The previously verified VM/guest implementation
and original application trajectories below remain the visual baseline.

`tests/provider-schema.test.ts` invokes four installed provider serializers with
a payload-capture hook that throws before dispatch and a rejecting fetch guard:
zero network calls. OpenAI Responses, OpenAI Completions and Google preserve the
root object plus `anyOf` contract. Anthropic drops root union/additional-property
constraints; the test demonstrates that weakened schema and proves the original
strict local validation rejects the same invalid call before manager access.
These are adapter compatibility tests, not live endpoint/model acceptance.
No provider-side strict sampling is requested.

## Baseline audit and corrected-package verification

Before the interface migration, `npm run check`: build and strict typecheck passed; **187 tests passed**,
none failed or skipped. Real installed pi loaded/reloaded all seven tools and
both commands with unchanged schemas; no model call or VM allocation was needed.

The independent requirement audit found two review-layer defects, now fixed in
`src/package.ts` and regression-tested in `tests/package.test.ts`:

- Authoritative receiver/transport refusal or uncertainty now updates the
  corresponding individual step, not merely the aggregate outcome. Observed
  text distinguishes those receipts from original subprocess facts; successful
  receipts never repair missing or failed action evidence.
- Routing annotations match exact action/execution identity before considering
  unambiguous step-ID fallback. Repeated step IDs retain their own reason and
  expectation, rather than inheriting the first execution's metadata.

The corrected renderer changes derived observation text, so previously sealed
packages were **not overwritten**. `scripts/reverify-live-packages.mjs` checked
and copied every original artifact into new derived packages and regenerated
only review metadata with current code. Both deliver and independently verify
with complete snapshots, passed execution and zero findings:

- Ubuntu: `test-evidence/final-package-verification/package-1/index.html`
- macOS: `test-evidence/final-package-verification/package-2/index.html`
- Provenance, original hashes and results:
  `test-evidence/final-package-verification/verification.json`

The original portable application recordings/viewers below remain intact.
Their dispatch-time artifacts are the source of the corrected snapshot viewers.
Recording integrity, execution success and human review are separate; human
review remains pending. Requirement-by-requirement audit gaps are closed by
these regressions and the two passing OS trajectories.

## Real installed inventories — both OS lines

Original evidence: `test-evidence/real-installed-inventory-20260913T164629Z/`.
Fresh service-owned Ubuntu and macOS clones ran the collector without application
installation or GUI interaction. Parent independently verified the retained
SHA-256 manifest, raw schema validation, unchanged before/after base fingerprints
and cleanup records. Both owned clones were destroyed and unregistered; bases
remained stopped. These fingerprints check file metadata, not disk-content hashes.

Inventory record count, defined as `len(validate_inventory(raw).applications)`:
Ubuntu **1,615**, macOS **144**. All configured sources reported available.
Actual browser metadata includes Firefox snap `155.0.1-1`, Chromium
`152.0.7977.64`, Google Chrome `153.0.8010.37` and Safari `26.6`.
Package records are not exclusively GUI applications.

Ubuntu's initial harness selected a shell warning instead of the hash and stopped
work. Its original blocked result remains intact. Offline inspection established
that the single digest in the retained successful guest hash response matches the
raw file; no rerun or altered inventory was used. This proves extracted metadata,
not app-launch correctness or visual acceptance. No production catalog was published.

## Candidate discovery with actual inventories

Evidence: `test-evidence/catalog-candidate-check/2026-09-13T17-05-26-088Z/`.
The isolated candidate exercised `createRelayTool → RelayManager → VmService →
GET /applications → Handler → load_catalog` against copies of real inventory
associations, checking original/current fingerprints before using them.
All **11 discovery cases** passed: Firefox, Chromium/Linux, Chrome/macOS,
no-match, opposite-OS exclusions, candidate-only stale association exclusion,
malformed-document HTTP 503, and restored discovery. Versions were checked
against retained raw inventories, not installation recipes.

Exactly 11 requests were recorded, all `GET /applications`; forbidden lifecycle
calls remained unused, and lease/registry sentinels remained unchanged.
Diagnostic hashes matched serialized public results. Parent verified retained
file hashes and successful command/cleanup evidence. The candidate server stopped,
its listener refused connections, and temporary storage was removed. An earlier
symlink-root fixture failure remains retained separately. This is discovery
verification, not selected-image lifecycle completion or production activation.

### Final audit follow-up

The exact metadata Unicode policy is now shared across collector, publisher,
backend and extension through a cross-language fixture corpus. Full relay gates
pass 231 tests after Unicode, startup-hook scope and diagnostic-retention fixes;
Pi startup/reload and isolated local-mirror Git installation passed again.
Candidate discovery was rerun successfully (11 cases) with the new policy:
`test-evidence/catalog-candidate-check/2026-09-13T17-18-28-157Z/`.
Maintenance exclusivity is now enforced across build (including phase runs),
refresh, promotion and extraction-only entrypoints using a per-Tart-home/line
advisory lock. Parent independently reran all **27 image fixture tests**: overlap
refusal before mutation, lock release on success/failure and surviving-child lock
retention are covered. This coordinates participating entrypoints, not unrelated
direct Tart operations. Backend gates passed after the startup-only catalog fix: **132 unit tests** and **35
integration tests** (existing ResourceWarnings retained).

### Selected-image lifecycle attempt — blocked, cleaned

`test-evidence/selected-image-lifecycle-2026-09-13T17-12-20-114Z/` preserves
explicit selection of Ubuntu from the canonical Firefox result. Public probe,
acquire and release executed. Read-only runtime discovery found Node but no
cua-driver on PATH or at bounded known locations; no filesystem-wide absence
claim is made. The attempt stopped before staging. All 41 retained hash entries
were independently verified, and cleanup proves the owned clone absent from
service/Tart, registry removed and base fingerprints unchanged. Stage/run,
snapshots, extraction, finish and portable-package acceptance were not reached.
No extra acquisition or replay occurred in this attempt. Historical staged
runtime support was verified offline and explicitly selected for a distinct attempt
at `test-evidence/selected-image-lifecycle-2026-09-13T17-25-23-718Z/`.
That attempt also stopped before stage: bounded graphical-session discovery returned
an empty list and a host assertion rejected it; this did not establish X11
unavailability. The support driver was not
transferred or executed. Parent independently verified all 49 manifest-listed file
hashes, exact cleanup and unchanged base fingerprints. No run, snapshots, declared
result or finished package exists for that attempt.

The diagnostic-only fresh attempt at
`test-evidence/graphical-discovery-2026-09-13T18-35-33-589Z/` retained an initial
empty sample with only TTY sessions, then an active Wayland session and successful
`xrandr --current` after a declared ten-second wait. See `discovery-0.json` and
`discovery-1.json`. This demonstrates startup timing and the test's native-X11
session-type mismatch in this new clone, not the state of the earlier destroyed
clone. All 44 manifest hashes, unchanged base fingerprints and exact cleanup were
independently checked. No installation or guest configuration changes occurred.
The additional screenshot test remains distinct from inventory/search validation;
its readiness checks and error reporting have been corrected offline. The expanded
standard `npm test` suite passed 246 tests, including those regressions; typecheck
also passed. See `test-evidence/search-implementation-check/relay-diagnostic-tests.log`.
The revised readiness loop has not yet been exercised in a new VM.

## Requirements-to-evidence map

| Design requirement | Implementation | Automated verification |
|---|---|---|
| Agent judges interruption; local work stays local | `src/probe.ts`, `src/index.ts` doctrine | `tests/transfer.test.ts`, `tests/extension.test.ts` |
| Probe current permissions, recorder, display activity and foreground, live images/capacity | read-only CUA/OS probes, `/health`, `/images`, `/vms` | probe unknown-state tests; vm-service actual endpoint tests |
| Required public `reason` for run and console-open, durably retained | Run maps `reason` to guest `because`; console-open retains reason and expected in a local lifecycle record without screenshots. Other actions reject reason. | Extension schemas, guest routing/refusal tests, manager host request checks, and console tests cover the separate annotation paths. |
| Dedicated fresh VM; pre-acquire registry; release/unregister | `src/manager.ts`, `src/registry.ts`, `src/vm-service.ts` | full HTTP lifecycle, cancellation, teardown/retry, cross-process registry tests |
| TTL heartbeat during long actions | manager independent bounded heartbeat | blocked receiver + live heartbeat and heartbeat-failure tests |
| Release on failure, enclosure end, reload and shutdown | guarded operations, settled/shutdown handlers, durable ownership | nonzero/refused/uncertain runs, stage/extract corruption, shutdown/settle/recovery tests |
| Multi-event guest browser-use | Fresh persistent Playwright server, per-event admitted clients | Browser subprocess/auth/persistence tests; live multi-event acceptance below |
| Never blindly replay uncertain input | SDK submissions, started markers and durable guest receipts | guest duplicate/concurrent identity tests; manager uncertain transport and acquire reconciliation tests |
| Runtime and support staged per lease; no image changes | receiver bundle + hash-checked vm-service push | stage integration and corruption tests |
| Recorded exec/uploaded script/streamed code/CUA events | SDK Session with VM-only transport; guest AdmissionEngine | actual built receiver CLI; script hashes; actual spawn/no-shell tests |
| Before capture immediately before dispatch, after explicit interval | unmodified relay-driver SnapshotStore + AdmissionEngine | guest exact contract/order and missing-capture tests |
| Chronological names, sequence/dispatch bindings, capture hashes | substrate identity/naming; adapter seeds snapshot sequence from retained journal | guest journal and package capture-integrity tests |
| Sender-declared consecutive text groups; individual records/shared pair | durable group state, substrate records, package reference resolution | group first/member/last/reuse/refusal tests and shared review pair tests |
| No video, CDP, local execution or spawn API; durable machines only through machine-service | no such extension surface; service restricted to loopback host or a Consul-listed instance (DC-29) | schema enumeration; package rejects video claims; service remote-target tests |
| Default evidence + declared outputs, full workspace opt-in | transfer inventory + immutable extraction versions | declared/undeclared extraction, full-workspace and source mutation tests |
| Original source and host checksums, safe paths | transfer two-sided inventory; package checks capture-time hashes before fresh manifest | transfer corruption/traversal/symlink; package bidirectional/provenance/tampering tests |
| Verified portable package and viewer | SDK manifest/trajectory/verifier + script-free offline viewer | package roundtrip, escaping, stable links, immutable originals and semantic revalidation tests |
| Separate delivery/completeness/execution/human review | DeliveryResult and viewer labels | refusal/incomplete/uncertain package tests; human review always pending |
| One relay tool with eight actions, status/review commands, discovery/reload | `src/index.ts`, `src/tool.ts`, `src/schema.ts`, discovery shim | extension/provider tests + real pi RPC smoke (schema and prompt snippet checked after reload) |
| Bounded agent-facing outputs | 50 KiB/2000 lines with private full-result file | extension byte/line limit tests |

## Package delivery decision

Use the documented `snap-deliver.ts` composition path, not
`SshTransport.finish()`. The adapter first validates original capture SHA-256
and byte count, then calls `buildManifest`, `buildTrajectory`, and
`verifyPackage`. It does not change relay-driver.

An incomplete coalesced pair remains classified as captured snapshot evidence.
The SDK's specific "group does not carry exactly one before/after pair" finding
is accepted **only** when independently diagnosed as an incomplete group; all
integrity and other structural findings remain fatal. This permits retaining
failed attempts without mislabeling delivery integrity as execution success.

## Scope boundaries

No in-process extension can execute a cleanup handler after SIGKILL or host
power loss. Durable pre-acquire ownership + stale-session recovery and the
service's TTL/grace reaper cover that boundary. Network-lost acquisition is
explicitly indeterminate; it is never retried automatically. A release failure
retains ownership/registry state and is surfaced rather than reported as done.

### vm-service destruction acknowledgement limitation

Source audit established that the current daemon catches teardown exceptions,
ignores the return status of `tart delete`, drops its lease record, and may return
`released: true`. A 404 is therefore not authoritative destruction evidence.
The adapter corroborates release using **read-only host** `tart list --format
json`; the exact clone must be absent before unregistration. It never mutates
Tart directly or uses it to communicate with a guest. An unavailable observer
or surviving clone retains ownership and surfaces the failure. The dependency
fix is handed off in `../vm-service/.handoff/pi-vm-relay-release-verification.md`;
no dependency implementation was modified.

The audit also found `/exec` returns only its last 64,000 characters. Large
inventories and execution receipts therefore use hashed file framing and
push/pull rather than relying on unbounded JSON in stdout.

Byte-copy transport failures have a bounded retry with retained diagnostics.
Setup/metadata commands retry only an explicit SSH authentication refusal
(`rc=255` with a password-authentication denial), which occurs before remote
dispatch. Arbitrary guest failures and uncertain receiver input are never
replayed. Live authentication failures remain acceptance failures, not evidence
of successful execution; retries do not substitute for investigating their cause.

Live Chromium staging exposed Unix-domain socket path limits beneath long
lease roots. The guest browser now uses an atomic private short `/tmp/pvr-*`
runtime directory for Chromium's ephemeral files; it is removed on normal
shutdown/startup failure, with VM destruction as final cleanup authority.
Durable authenticated channel state stays in the lease root, outside workspace
extraction. Long-path, private-mode and cleanup regression tests cover this.

## Live acceptance — Linux and macOS passed

**Dependency update (2026-09-13):** the user subsequently authorized vm-service
hardening. Per-lease host-held SSH keys are implemented and passed fresh Ubuntu
and macOS candidate acceptance, including independent command/transfers, restart,
negative authentication cases and verified cleanup. See
[`../vm-service/docs/lease-ssh-keys.md`](../../vm-service/docs/lease-ssh-keys.md).
Production was subsequently drained, activated at commit `a0ac8d4`, and verified
with a fresh production key-backed Ubuntu lease, command and binary transfer,
followed by verified cleanup. The resumed goal is now rerunning complete relay
UI acceptance and investigating the Linux capture discrepancy below; the
service authentication tests alone are not evidence that those UI gates passed.

Both OS live acceptance gates now pass on key-backed production. Human review
remains pending. Historical fresh Ubuntu and macOS attempts
exposed intermittent vm-service password authentication refusals after
successful readiness/identity probes. The Ubuntu diagnostic guest's own DEBUG3
journal records empty first-password submissions; the exact host-side cause
remains unproven. See the dependency handoff
`../vm-service/.handoff/2026-09-12-ubuntu-ssh-empty-password.md`.

### Passing Linux acceptance (current key-backed production)

`test-evidence/ubuntu-key-backed-acceptance-20260913-031124/walkthrough-review/index.html`
is the portable video walkthrough. Parent independently reran
`scripts/live-smoke-verify.ts`, verified all 177 portable-file hashes, and fully
decoded the original MP4. The delivered relay package reports verified delivery,
complete snapshots, passed execution, pending human review, and no findings.
There are 13 steps (`count(walkthrough.steps)`) and 18 snapshots
(`count(manifest.snapshots)`); five distinct native keystroke actions reference
one declared before/after group pair. Navigation, focus, typing and confirmation
pairs visibly change; original frame review and corrected observations are
retained, separate from DOM assertions. Exec, uploaded script, streamed code,
persistent browser events, native CUA group, explicit extraction and finish pass.
Exact VM destruction and registry removal are verified.

The capture discrepancy was reproduced and resolved in
`test-evidence/ubuntu-key-backed-20260913-030307/diagnostic-review/index.html`:
cua-driver 0.26.0's default overlay froze X11 root pixels while the same browser
advanced its DOM/title. Stopping that daemon and restarting with the documented
`serve --no-overlay` restored root/CUA capture without restarting browser,
display or recorder. The immediate after snapshot was still old and is retained;
later observations demonstrate restoration. The acceptance replacement started
with `--no-overlay`. README and stage-action guidance require this Linux setup.
No dependency or golden-image source was modified for the remedy.

### Passing macOS acceptance (current key-backed production)

`test-evidence/macos-vision-key-backed-20260913-v3/walkthrough-review/index.html`
contains the portable native-plus-browser walkthrough. The image-capable reviewer
observed consent dismissal, unobscured native `relay` after a five-key group,
actual close-button interaction on a distinct desktop session, and unobscured
browser `relay` with `Playwright click confirmed`. All sixteen recorded steps
(`count(walkthrough.steps)`) completed; explicit extraction and finish passed.
The parent independently verified all 374 portable-file hashes and fully decoded
the original MP4. The manifest retains original-frame UTC beacon mapping,
cross-checks against later decoded frames, dimensions, duration and relative
paths. Recording and execution are complete/passed; human review is pending.

The application was removed after preservation, the manager became inactive,
and exact VM destruction and registry removal were verified without touching
foreign leases. Earlier v1/v2 attempts remain retained: v1 lacked explicit
consent desktop scope; v2 used incorrectly half-scaled desktop coordinates and
later encountered an ended consent session. The harness now constructs explicit
desktop input, requires visually confirmed dismissal, and creates a distinct
close session immediately before that input. Regression tests cover the scope
and review guard. Desktop coordinates use the original screenshot pixels, not
coordinates divided by Retina scale.

### Historical attempts

Retained host evidence (under gitignored `test-evidence/`):

- `ubuntu-final-20260912-223050/REPORT.md`: failed read-only recorder guard;
  original full-display recording finalized and hash-verified before destruction.
  `failure-review/index.html` is the portable incomplete-attempt viewer.
- `ubuntu-frame-mapped-20260912-224406/REPORT.md`: reached Chromium staging and
  exposed the long Unix-socket path defect, now fixed and regression-tested.
  Its original recording and explicit per-frame timeline mapping are retained
  in `failure-review/`.
- `ubuntu-short-runtime-20260912-225455/REPORT.md`: the next fresh attempt failed
  authentication during X11 setup, before reaching the fixed browser runtime.
  No recording or input started. `cleanup.json` verifies destruction and
  registry removal; `audit-manifest.json` verifies retained audit checksums.
- `macos-acceptance-blocker.md`: first three fresh macOS attempts, actual daemon
  TCC permissions and screenshot, and verified cleanup. No input passed.
- `macos-20260913-native-a4/ACCEPTANCE.md`: real admitted native click/grouped
  keystrokes, persistent multi-event Playwright, script/extraction and complete
  snapshot package **passed**. Independent parent verification of the delivered
  package reports no findings; all 379 walkthrough-file hashes and full MP4
  decoding also pass. `walkthrough-review/index.html` preserves the full attempt
  and marks failed fixture closure and obscured browser footage explicitly.
  Application visual acceptance is incomplete and human review pending. The
  exact lease was recovered after a host timeout, with no replay, then its app
  removed and VM destroyed. This used the previous browser-temp bundle, so it
  does not verify the subsequent short-path fix.

Latest Ubuntu native-X11 attempts:

- `ubuntu-clone-x11-20260912-232832/`: actual short-runtime Chromium launched;
  exec, script, streamed code, navigation and focus returned completed receipts.
  Request-transfer authentication failure prevented CUA input. Identical
  about:blank screenshots do **not** establish visible fixture success. A
  read-only audit independently recomputed all ten snapshots plus preflight as
  byte-identical, and ffmpeg raw-frame checksums were also unchanged across
  navigation/focus. This is not merely a package-file cache. A CUA overlay/root
  readback warning is a concrete lead, but hidden-page/compositor behavior is
  not yet distinguished; no source-level root cause is claimed. Recorder
  stop was refused; retained original MP4 is unplayable and remains incomplete.
- `ubuntu-fragmented-x11-20260912-234106/REPORT.md`: short-runtime browser and
  latest receiver staged successfully. Guest exec completed, but repeated
  receipt-transfer authentication refusals made the host outcome **uncertain**;
  no operation was replayed. The finalized original recording, causal snapshot
  pair and recovered guest evidence were transferred before destruction and
  verified in `failure-review/index.html`. Both clones were destroyed and
  unregistered. Full Linux visual acceptance and finish remain outstanding.

The macOS a6 consent attempt additionally exposed an adapter error: cua-driver
can report `desktop_escalation_required` with subprocess exit zero. The receiver
now retains that structured pre-input refusal as **refused**, treats other
structured CUA failures as **uncertain**, preserves original output, and disables
further input. Generic exec JSON is not reinterpreted. Regression tests verify
both classification and the fail-closed latch; prior artifacts stay unchanged.

MacOS a9/a10 retention and native evidence:

- `macos-20260913-native-a9/ACCEPTANCE.md`: consent visibly dismissed, then a
  session-scope error correctly became uncertain under the new receiver.
  A harness cleanup error lost the finalized recording; the retained MP4 is
  incomplete/unplayable. This attempt is **not** a valid video walkthrough.
- `macos-20260913-native-a10/ACCEPTANCE.md`: separate scopes visibly verified
  consent dismissal and native grouped typing of `relay`. Command-W did not
  close the fixture, so browser acceptance never began. The corrected retention
  barrier preserved the original before app cleanup/destruction, including
  recovery of the exact lease after a review timeout. Independent parent
  verification confirms all 274 portable file hashes. Recording is complete,
  application execution failed, acceptance incomplete, human review pending.

- `macos-20260913-native-a11/ACCEPTANCE.md`: consent visibly dismissed, then
  receiver authentication refusal caused uncertainty. Recorder-stop refusal
  triggered the retention barrier. Read-only reconciliation established the
  exact owned recorder was still active; a separately authorized cleanup request
  finalized it without replaying any desktop input. Original MP4 and events
  transferred and decoded before app removal. Independent parent verification
  confirms all 338 portable file hashes. Same-root stale-owner recovery then
  destroyed the exact VM and removed its registry entry; host Tart and process
  checks confirm no relay-smoke VMs or caretaker processes remain. Recording
  complete, execution uncertain, acceptance incomplete, human review pending.

The application-only video harness now verifies source/decoded frame counts,
strict timestamp order, media bounds, and explicit per-frame mappings instead
of assuming encoding preserves a constant offset. Read-only guard retries are
explicit and audited; mutation commands and uncertain input are not replayed.
`npm run check` includes the harness regression tests.

Application-level video is not extension video support. A preserved valid
recording is not successful execution, and human review remains pending.
The subsequent `linux-diagnostic-20260913-004123/blocked-review/index.html`
retains a checksum-verified no-video attempt: native X11 became ready, but
recorder start was denied SSH authentication, so the capture discrepancy could
not be investigated. The clone was destroyed and unregistered.

Both OS lanes have now been rerun successfully on clean disposable clones as
recorded above; historical failures do not replace those passing gates. The historical service
transport blocker was addressed in the separately authorized vm-service change
and activated before this resumed verification. The failed attempts above remain
unchanged evidence; they are not evidence of a current authentication failure.
