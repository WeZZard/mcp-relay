# pi-vm-relay — Design Overview

*Historical: this document was inherited from pi-vm-relay, which is retired.
mcp-relay replaces it and carries this design forward; installation
wording below has been updated where it named pi-vm-relay's own install
path, and is otherwise left as written.*

| Item | Value |
|---|---|
| Document type | Design entry point and status summary |
| Product | One Pi tool for disposable-VM discovery and recorded execution |
| Status | The user-approved screenshot-delivery revision is implemented and automated-tested in this worktree. Deployment and live acceptance are not claimed. |
| Evidence | [Implementation verification](verification.md) |

## Document map

UX concerns, engineering contracts and implementation evidence are documented
separately, using UX-specification and engineering-RFC sections.

| Document | What it owns |
|---|---|
| [UX design](ux-design.md) | Problem, users/jobs, goals, user flows, interaction examples, empty/partial/failure states, presentation and UX acceptance |
| [Technical design](technical-design.md) | Architecture, API/data contracts, algorithms, lifecycle, evidence, security, compatibility, rollout and engineering acceptance |
| [Console contract](console.md) | Implemented guest-sharing actions, nested observations, ownership and recovery. |
| [Selected environments](selected-environments.md) | The agreed isolated-store configuration, dependency injection, and backend ownership contract. |
| [Screenshot delivery](screenshot-delivery.md) | The implemented worktree contract for typed command-result images, owner-scoped recovery, application-image authorization, and presentation failures, with explicit acceptance limits. |
| [Lifecycle fixes](lifecycle-fixes.md) | Decisions and design for session end, cancelled acquisition, finish extraction and cancellable guest commands, with the two items that wait for the owner's decision. |
| [Code runs in any guest](guest-code-runs.md) | The backends, the software the relay assumes in a guest, and the host paths it reads (DC-12 to DC-15). |
| [Verification](verification.md) | Measured implementation evidence, historical gates and environment-specific acceptance—not unimplemented design promises |
| [README](../README.md) | Installation and operational instructions, with worktree-only features identified separately from deployment. |

UX examples illustrate the interaction. The technical document is authoritative
for field semantics, validation and runtime invariants. These are design contracts,
not assertions that every described capability is already shipped.

## Product summary

The operating agent chooses which work runs in a guest (DC-14). That work runs in a
dedicated VM with recorded actions, declared outputs
and accountable cleanup. Applications compose VM-use subagents by prompt; pi-vm-relay does not
spawn them or record video itself.

The planned discovery flow finds installed applications by name and lets the agent
choose the image and operating system. Provision the image first, then extract
its installed-application inventory for search. Operating instructions and image
acceptance remain separate from that inventory.

## Recovery and image-readiness revision (2026-09-16)

- This revision records the owner's decisions after the `progressively-homepage` investigation. It describes target behavior, not a completed implementation.
- The application inventory belongs at `pilot-images/images/<image>/applications.json`. Rename the existing configuration tree from `lines/` to `images/` while keeping image IDs and Tart base-VM names unchanged.
- Host-specific associations use a shared configured local state directory outside the repository, defaulting to `$XDG_STATE_HOME/pilot-images` or `~/.local/state/pilot-images`.
- Each application deliberately added by provisioning uses a shared baseline test plan for basic availability and startup. Unchanged OS software may remain in the catalog but is not automatically tested; our image-configuration checks remain required. Special applications add separate extensions under `applications/<application-id>/` instead of changing the shared baseline for all applications. Image acceptance executes the applicable plans on a fresh clone through vm-service's actual execution environment.
- An ordinary tool failure must not destroy the VM or prevent the agent from investigating, repairing the environment, and issuing another operation. Uncertain operations are reported and are never automatically replayed.
- Use the existing state machine and persisted ownership records so lifecycle state does not depend on conversation history. Context compaction does not reset the VM state or prevent agent recovery.
- Application matching stays in the extension. This revision does not introduce pagination or change the existing search response contract.
- The `run` action accepts an optional execution `timeoutMs`, with a 120,000 ms default and a 3,600,000 ms maximum. The execution timeout is independent of the screenshot delay.
- Successful `finish` and explicit `release` end the VM lifecycle. Session completion, shutdown, or replacement retains the VM; inactive sessions stop renewing it and report the confirmed expiration time. Active work renews the lease, and reload or resume reconciles persisted ownership without replay.
- Host observations and guest readiness checks are separate concerns. The host idle-time query uses `ioreg -r -c IOHIDSystem`.
- An isolated environment selects the backend, image repository, Tart store, and mutable state directories together. A worktree is optional, but it does not replace a separate Tart store. Operations and destruction verification use the same selected configuration.
- Failure responses must identify the command outcome, available diagnostic output, evidence location, and actual VM lifecycle state without implying that failure means release.

### Documents and implementation status

- [Technical design Sections 3.5–3.6](technical-design.md#35-execution-timeout) define timeout and probe requirements.
- [Technical design Sections 4.1–4.1.1](technical-design.md#41-data-ownership-and-inventory-extraction) define inventory ownership and application test plans.
- [Technical design Sections 5–5.2](technical-design.md#5-lease-lifecycle-persistence-and-recovery) define recovery and cleanup requirements.
- [The implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md) tracks work, dependencies, tests, and unresolved decisions.
- The working tree implements relay recovery, configurable timeouts, scoped probes, catalog migration, shared application baselines, pinned Ubuntu capture provisioning, and fresh-work-clone promotion checks. Automated work-image and fresh-clone acceptance, plus real relay failure/recovery sequences, have passed on both OS families. Production activation and manual review have not occurred. See [verification.md](verification.md) for results and limitations.

## Guest-sharing console consumer implementation

- The relay source now implements optional VNC acquisition, read-only acquisition capability discovery, and explicit owned-console resolve/open/cancel actions. [The console contract](console.md) specifies the implemented fields and backend expectations.
- This implementation uses service-owned guest sharing with unmodified Tart. It adds no private Tart protocol or client-side viewer launcher.
- Component tests establish the implemented contract, not live viewing, authentication, correct pixels, or human confirmation. [Verification](verification.md#console-rollout-status) records deployment and configuration observations separately.

## Live VM viewing requirements (2026-09-20)

- Implementation was authorized on 2026-09-20. The backend contract and relay consumer now exist; the original missing-API finding in [the historical investigation](live-view-investigation.md) no longer describes current source. Live acceptance and viewer interruption require separate authorization.
- The user must be able to watch the same leased guest desktop that the agent operates and relay captures. Retained screenshots, evidence review pages, and recordings do not substitute for live viewing.
- Relay must separate read-only discovery of the owned VM's viewing capability from an explicitly requested operation that opens a standard viewer in the service host's logged-in graphical session, not on an arbitrary remote client.
- Discovery must use authoritative lease, backend, and selected-environment identity. Consumers must not guess VNC endpoints or bypass relay through vm-service, SSH, or Tart.
- Target resolution, viewer launch, connection establishment, and correct-display confirmation are separate outcomes. A successful local launch does not prove that the correct guest display is visible.
- Viewing must preserve ownership, lease renewal, and verified destruction. Credentials must not enter model-visible output or evidence, and any temporary connection resources require explicit cleanup.
- Required viewing must be established before guest application work. A live human view does not replace usable relay snapshots for the agent.
- The black-snapshot disagreement reported in the handoff remains a separate investigation. Live viewing must not be claimed to fix it without evidence.
- [UX design Section 6.8](ux-design.md#68-live-viewing-of-the-owned-vm) defines the supported flow and failure experience.
- [Technical design Section 3.8](technical-design.md#38-live-viewing-of-the-owned-vm) defines ownership, security, lifecycle, and pending live acceptance requirements.
- `acquisition-capabilities` discovers startup configuration without allocation. `acquire.vnc: true` opts into guest preparation; it never opens a viewer. `console-resolve`, `console-open`, and `console-cancel` operate on the owned lease and nested viewing attempt.
- Linux uses same-session X11 sharing with server-enforced view-only access. macOS uses Apple's Screen Sharing and human authentication; the human must choose Standard sharing of the existing console. It cannot claim server-enforced view-only access or automatically verified display selection.
- The [source handoff](../.handoff/2026-09-20-live-vm-viewer-for-human-observation.md) retains the original request and evidence locations. Component tests do not satisfy live acceptance, and material design changes still require review.

## Screenshot-delivery revision (2026-09-21)

- The user approved runtime implementation after the original documentation proposal. The [screenshot-delivery contract](screenshot-delivery.md) now describes the screenshot-delivery tool changes, including `image`. The installed plugin and consumer integrations were not modified; deployment and live acceptance remain separate work.
- Recorded operations return their saved after-image as typed final tool content when the explicit snapshot plan captures that phase and delivery succeeds. Text-group members without an after-capture do not receive an invented image. Execution and image-delivery outcomes remain independent, including through Pi's native error-result hook.
- The implemented `image` action has closed display, declared-application, and reference selectors. Recovery retrieves the same authorized original without input, capture, consumer-directory export, or acquisition. Immutable references bind owner, enclosure, backend, and original identity; retained recording lineages permit verified local recovery without a reachable guest.
- Originals are bounded to 64 MiB, 40,000,000 decoded pixels, and 32,768 pixels per dimension. Previews use Pi's public `resizeImage` helper with 2,000 × 2,000 pixel and 4 MiB base64-data limits. JSON/journal metadata is bounded to 4 MiB per file. Each delivery has a total 90-second deadline and three shared byte-transfer attempts, including metadata transfers.
- Relay display evidence and application screenshots retain separate identities and storage. Finalization merges verified originals at canonical snapshot paths without overwriting conflicts. UUID full-workspace destinations preserve earlier attempts.
- Real Pi SDK 0.85.1 tests cover final text/image results, error flags, persistence, and image blocking. Four provider adapters are tested offline for normal/error serialization and non-vision behavior. The exact affected gateway, live model inspection, and actual VM acceptance remain unverified.
- The pre-merge screenshot-delivery `npm test` run contains 438 tests: 435 passed, two failed, and one was skipped. The failures depend on missing historical `test-evidence/ubuntu-20260912-2127` and sibling `pilot-images/inventory/collect.py` fixtures. Build, typecheck, RPC smoke, and clean-install checks passed; not all gates passed.
- The [investigation plan](../.plans/2026-09-21-screenshot-delivery.md) preserves the original diagnosis and proposal rather than retroactively describing them as implemented. The [verification report](verification.md#screenshot-delivery-investigation-2026-09-21) separates automated evidence from pending agentic inspection and human review.

## Decision summary

| Decision | Target behavior |
|---|---|
| One tool | `relay` has thirteen explicit actions: `search`, `probe`, `acquire`, `stage`, `run`, `image`, `extract`, `finish`, `release`, `acquisition-capabilities`, `console-resolve`, `console-open`, and `console-cancel`. No legacy tool aliases are added. |
| Discovery | `search` with required nonblank `name` and optional hard `os` filter (`linux` / `macos`) |
| Results | Applications grouped with image installations, versions, OS and architecture |
| Truncation | Bounded complete records and an accurate `truncated` flag retained as diagnostic evidence |
| Minimal scope | No categories, fuzzy/semantic search, caller limit, cached pagination or continuation token |
| Reasons | Required for `run` and explicit user-requested `console-open`; other actions reject `reason`. Console intent is not screenshot or authorization evidence. |
| Annotation vs identity | Natural-language reason describes intent; structured IDs govern identity/control |
| Inventory | Extract installed applications after provisioning and publish them under `images/<image>/applications.json`. |
| Image acceptance | Test explicitly provisioned software using shared baselines and isolated extensions; retain required image-configuration checks on fresh clones. |
| Error recovery | Preserve the VM and allow agent-directed investigation and repair after tool failures. |
| Timeout | Make `run.timeoutMs` configurable and separate from the screenshot delay. |
| Cleanup | Use explicit completion or release and lease expiration without silently defeating agent recovery. |
| Probe scope | Distinguish host observations from guest readiness. |
| Installation | npm (`npm install -g @wezzard/mcp-relay` or `npx @wezzard/mcp-relay`), the Claude Code plugin, or `pi install npm:@wezzard/mcp-relay` via pi-mcp-adapter; pi-vm-relay's git-based `pi install` is retired, and there is no tarball distribution |
| Evidence review page | Owner decision, 2026-09-28: every delivered package's `index.html` must be well designed: light, warm, minimal, modern and vivid, with a top row for the run, a center row of snapshot viewport and step panel, and a bottom track of step thumbnails. Tabs switch between the trajectory and the overview. The viewport shows one snapshot at a time, the arrow keys move between views, and Focus on errors limits the track's emphasis and the arrow keys to steps with errors; the page's policy therefore admits that one script by its hash. The generator is redesigned, not a single page; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Human review | Owner decision, 2026-09-28: the relay is a computer-use server that records a trajectory, so it performs no human review. It no longer writes a `humanReview` outcome into `summary.json` or its delivery result, and the page shows no review verdict. Packages delivered with the former fixed `pending` value still verify. |
| Verdict explanations | Owner decision, 2026-09-28: an incomplete snapshot verdict or an uncertain or failed execution verdict must be explained on the page. The relay states each reason in plain language, derived from the rule that produced the verdict, and links it to the steps it concerns; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Review page dev server routes | Owner decision, 2026-09-28: the dev server addresses a package by the project that ran the relay and then the run, as `/<project>/<run timestamp>-<run id>/`, because a person recognizes a run by its project and time; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Snapshot viewport | Owner decision, 2026-09-28: a step with snapshots always shows its before and after snapshots side by side, with no switch to either one alone. Pressing a snapshot opens it in a lightbox. Each thumbnail shows how long its step took, and the viewport uses the page's background; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Lightbox and layout | Owner decision, 2026-09-28: every shape uses continuous corners. The lightbox moves through the steps with the arrow keys and two arrows that name the neighbouring item, shows commands in larger text, and also serves the Overview's images. Focus on errors sits below the view tabs and only in the Trajectory view. The Overview's content is centered, its panel keeps an even margin and has no Start button, and the page shows when the run happened; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Header and overview | Owner decision, 2026-09-28: the page's title is Relay, with the task's name beside it, under a designed mark rather than a plain circle. The start time sits in the statistics under the title, in UTC and in the reader's local time. The Overview is one centered column in larger text on one type scale, and the package's identity and files close it instead of filling a right panel; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Capsules and lightbox backdrop | Owner decision, 2026-09-28: the statistics and the start time share one line. Capsule-shaped controls keep fully round ends rather than continuous corners, step numbers use a monospace face, and the lightbox sits on a dark backdrop while its controls keep the light theme; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Lightbox keys and motion | Owner decision, 2026-09-28: entering and leaving the lightbox is animated. Space opens the selected step's lightbox at its before snapshot, and the Trajectory view shows its keyboard shortcuts beside the verdicts; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Lightbox continuity | Owner decision, 2026-09-28: the lightbox's arrows show only the step number and before or after. Its content enlarges from, and returns to, its place on the page, and its controls keep their size and rise from the bottom of the window; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Unwrapped step panel | Owner decision, 2026-09-28: the Trajectory view's right panel loses its white card; its contents sit directly on the page's background, to reduce the layers; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| One snapshot per view | Owner decision, 2026-09-28: the viewport shows one snapshot at a time; the arrow keys move between views (a step's before, its after, or a command). The step's name and duration head the snapshot, and a capsule with the snapshot's role and capture time sits right below it; the right panel no longer repeats the name, so it stays put while a step's views change. The track shows a thumbnail per view, two for a step with snapshots. In the Overview the arrow keys do nothing outside the lightbox. This supersedes the side-by-side comparison; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Step panel heading | Owner decision, 2026-09-28: the right panel is headed by "Step N of N", set since as a STEP legend beside a dark display with amber digits (owner decision, 2026-09-28: the step number and the viewport's step title take the vintage hardware type, the title in bold monospace as wide as its monitor), with the stable link icon, not colored, at its end; the step's kind and time sit on the line below, with the execution verdict at its end; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Review page header | Owner decision, 2026-09-28: the header's mark is two frames, the second stepping in front of the first, for a step's before and after snapshots, chosen from five candidates; it spans the title and the statistics line, the statistics start at the title's leading edge, the task badge is gone, and the right end is centered vertically in the row; the start time on that line omits the year, which the Overview's package facts give; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Focus on errors placement | Owner decision, 2026-09-28: the Focus on errors checkbox sits at the bottom left of the viewport without a count, and the page leaves it out when no step has errors; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Text output window | Owner decision, 2026-09-28: a declared JSON or log output opens in a window within the page that shows its contents and offers a download, instead of a link to the file. The page embeds small text outputs (at most 256 kB each and 2 MB in all) because a page opened from disk can neither read nor download the files beside it; larger or non-text outputs stay links; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Package file windows | Owner decision, 2026-09-28: manifest.json, summary.json and trajectory.json open in the same window. manifest.json records the page's checksum, so the page cannot hold it; the owner chose to show it framed from the file rather than embed a copy without the page's entry or keep a link. Larger text outputs are framed the same way. Delivery settles trajectory.json before the page from a provisional manifest, since the trajectory reads only its snapshots, media and segments; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Review app on demand | Owner decision, 2026-09-28: the review page is never generated. Delivery writes the package's data only, with no `index.html`; the package is the data. The review page is one data-driven app shipped with the relay, and the existing trajectory review command (`/mcp-vm-relay:trajectory`, the `relay_trajectory` tool) verifies a package and opens the app on it, rather than a new command. Because a page opened from disk cannot read the files beside it, the tool serves the app, the package's review data and its files on 127.0.0.1 from the relay's own process. This supersedes the page written at delivery, its byte-exact re-rendering at verification, and the embedded and framed file windows of the rows above; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Review app theme | Owner decision, 2026-09-28: the review app's theme uses a 1980s stripe palette (navy, blue, steel blue, teal, cream, orange, red and dark red, on black) as its tint colours, over light, warm and layered backgrounds, as one colour system: no colour outside the palette, its tints, warm neutrals and its black is used. The main viewport is light gray with a fine-grained dot pattern; commands in it are shown on a monitor showing a terminal, whose display presents the command and whose border presents the step's information and controls, with no stand. Snapshots sit on the same monitor, whose chin carries the view's name and time between the keys to the neighbouring views; the step's title stays above the monitor. Controls, labels, text blocks, badges and indicators take a 1980s vintage style. Palette colours tint by meaning: labels in steel blue, everything tied to a status in that status's colour (teal, orange, red, and dark red for relay defects), and the Overview's section separators in their section's tint; body text keeps the text colour. UI elements are laid out on a grid, and type is held to a limited hierarchy of faces, sizes and weights. Corners are continuous rather than rounded. Main content and navigation are centred or balanced on the visual centre of their containers. The app icon's shape and colour are redesigned in the palette, as a square badge with continuous corners where the eight stripes turn around a large cream circle. The stripes appear only in the icon: rules and edges elsewhere use a solid navy, and the monitor's chin carries the icon itself. This replaces the dark navy stripe theme, the 2026 colours, Mac OS 9, iOS 7, BeOS and Italian 1960s pop themes of the same day; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Relay Trajectory Viewer | Owner decision, 2026-09-28: the review app is named Relay Trajectory Viewer in the filesystem only; its code lives in `src/relay-trajectory-viewer/`. The page still shows Relay as its title, and tool, command and address names are unchanged. |
| Derive at review | Owner decision, 2026-09-28: finishing a relay extracts the raw evidence and seals it with `manifest.json`; it writes nothing derived from that evidence. The steps, verdicts and reasons a review needs are derived when the package is reviewed, by the relay doing the review, so a corrected rule applies to every package, old or new. Verification checks integrity and the raw evidence's consistency, never derived bytes; the `summary.json` and `trajectory.json` of earlier packages are sealed records only. This supersedes the summary and trajectory files of delivery. |
| Actionable verdicts | Owner decision, 2026-09-28: every badge and reason on the review page must tell the reader something they can act on, and says what. A finding the reader can do nothing about is a defect of the design or the code and is fixed at its source rather than shown. Diagnostics therefore no longer make snapshots incomplete (superseding the 2026-09-17 behaviour noted in [verification](verification.md)); a step whose guest execution is missing makes that step's execution uncertain rather than the snapshots incomplete; inconsistencies in the relay's own records are shown as relay defects to report and change no verdict; and incomplete snapshots no longer make the whole run uncertain, since each step without its snapshots is uncertain itself. |
| Trajectory viewer moves out | Owner decision, 2026-09-30: the review app moves to pi-secretary's `extensions/secretary/computer-use/viewer/`, which shows a computer-use agent's session beside each machine's review data. The relay removes the app, its review server, the `relay_trajectory` tool, the trajectory command and the `dev:review-page` script, and offers eighteen tools. It keeps `@wezzard/mcp-vm-relay/review-data`, with the same type names, and verification. This supersedes the review app rows above as far as the relay is concerned; see [UX §6.10](ux-design.md#610-evidence-review-page). |
| Release gate | Owner decision, 2026-09-28: the review app branch is merged and released only after all its open items are cleared. |

## Design boundaries

The UX and technical specifications cover discovery, the dedicated VM lifecycle,
recorded execution, evidence, cleanup and native Pi installation.

- Inventory publication and catalog reading must agree on image identity and file locations.
- The [implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md) owns unresolved decisions and implementation sequencing.

The UX and technical documents contain Mermaid diagrams for user journey,
component ownership, discovery, lease lifecycle and recorded execution. They are
conceptual diagrams, not assertions of internal state enum names or new backend
endpoints.

## Verification boundary

Use [verification.md](verification.md) for implementation status, automated gates
and environment-dependent evidence. A design document or historical trajectory
is not proof that a capability is implemented. Repository privacy and public
licensing remain owner decisions.
