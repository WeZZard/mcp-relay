// Bounded real integration: one explicit selected image, public tool, production HTTP only.
//
//   tsx scripts/selected-image-lifecycle.ts --run --instance <root> --tart <path> [--support-driver <path>]
//
// It drives a second instance that machine-service's launcher started under
// <root> (`second-instance start --root <root> --port N --session-port N
// --tart-home <store>`), never the installed one (DC-66, DC-7x-LIVE-1): the
// manifest's ports are not 6240 or 6241, its daemon carries the manifest's ID,
// its store and auto-prune off, its /health carries the launcher's mark with
// that ID, and the run touches only the instance's `si-<id>-` clones. The
// store may be the operator's own, from which the instance only reads bases
// (machine-service DC-246). The lifecycle is scripts/lifecycle.ts.
import { supportArgument, verifySupportDriver } from './selected-image-support.js';
import { closeLiveRun, openLiveRun, project, retainedSelection, runLifecycle } from './lifecycle.js';

const args = process.argv.slice(2);
if (!args.includes('--run')) throw Error('Explicit --run required');
const supportPath = supportArgument(args);
// Validate before creating evidence or making any service call. No implicit fallback.
const support = supportPath ? await verifySupportDriver(project, supportPath) : undefined;
// The instance is named, never defaulted, and checked before anything is made.
const run = await openLiveRun('selected-image-lifecycle', args);
await closeLiveRun(run, await runLifecycle(run, { select: retainedSelection }, support));
