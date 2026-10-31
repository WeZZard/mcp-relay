/**
 * Whether a durable machine's runs take snapshots (docs/durable-machines.md §5,
 * DC-32). The cua-driver command-line tool hands its work to the
 * `cua-driver serve` daemon, which holds Screen Recording as
 * `com.trycua.driver`, so the daemon's own answer decides, never
 * machine-service's `permissions`.
 */
export type CaptureState = 'granted' | 'denied' | 'unknown' | 'daemon-not-running' | 'absent';
export interface CaptureDecision { capture: boolean; state: CaptureState; reason: string }
/** What `cua-driver permissions status --json` printed, or why it could not run. */
export type PermissionAnswer = { code: number; stdout: string; stderr?: string } | { error: string };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * `software` is the machine's `capabilities.software`; `answer` is the
 * permission status, absent when cua-driver is not installed and so not asked.
 */
export function durableCapture(machine: string, software: unknown, answer?: PermissionAnswer): CaptureDecision {
  const version = object(software)?.cua_driver;
  if (typeof version !== 'string' || !version) return { capture: false, state: 'absent', reason: `${machine} lists no cua-driver in its capabilities, so runs take no snapshots.` };
  if (!answer) return { capture: false, state: 'unknown', reason: `cua-driver's permission status on ${machine} was not read, so runs take no snapshots.` };
  if ('error' in answer || answer.code !== 0) {
    const why = 'error' in answer ? answer.error : `exit ${answer.code}: ${(answer.stderr || answer.stdout).trim().slice(0, 300)}`;
    return { capture: false, state: 'unknown', reason: `\`cua-driver permissions status --json\` failed on ${machine} (${why}), so whether its daemon may record the screen is unknown and runs take no snapshots.` };
  }
  let status: Record<string, unknown> | undefined;
  try { status = object(JSON.parse(answer.stdout)); } catch { /* read below as unknown */ }
  if (!status || typeof status.screen_recording !== 'boolean') return { capture: false, state: 'unknown', reason: `cua-driver's permission status on ${machine} is not the expected JSON, so whether its daemon may record the screen is unknown and runs take no snapshots.` };
  const attribution = object(status.source)?.attribution;
  if (attribution !== 'driver-daemon') return { capture: false, state: 'daemon-not-running', reason: `cua-driver on ${machine} answered for ${typeof attribution === 'string' ? `"${attribution}"` : 'no source'}, not for its daemon, so the \`cua-driver serve\` daemon is not running and runs take no snapshots. Start CuaDriver on the Mac, then call relay_stage again.` };
  if (status.screen_recording !== true) return { capture: false, state: 'denied', reason: `The cua-driver daemon on ${machine} lacks Screen Recording, so runs take no snapshots. Grant it to CuaDriver in System Settings on the Mac, then call relay_stage again.` };
  return { capture: true, state: 'granted', reason: `The cua-driver daemon on ${machine} holds Screen Recording, so each run takes before and after snapshots.` };
}
