import { Type, StringEnum } from './typebox.js';
import type { Static, TSchema } from 'typebox';
import { Check } from 'typebox/value';

const closed = { additionalProperties: false };
const reason = Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S', description: 'Intent of this execution. Retained as evidence, never identity, authorization or a retry key.' });
const optionalReason = Type.Optional(Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S', description: 'Optional intent, retained as evidence. Default: derived from the call.' }));
const interval = Type.Number({ minimum: 0, maximum: 300000, description: 'Wait in milliseconds from the end of the call to the after-snapshot. Optional; the relay has a default.' });
const id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' });
/** The guest a call acts on: the name relay_acquire answered (DC-20). */
const guest = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,47}$', description: 'The guest this call acts on: the name relay_acquire answered.' });
const snapshots = Type.Object({
  afterIntervalMs: Type.Optional(interval),
  group: Type.Optional(Type.Object({ groupId: id, phase: StringEnum(['first', 'member', 'last'] as const), afterIntervalMs: Type.Optional(interval) }, closed)),
}, { ...closed, description: 'Optional. Consecutive keystrokes may form an explicit text group (first/member/last); only first gets a before-snapshot and only last an after-snapshot.' });
const step = Type.Object({ id: Type.Optional(id), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), expected: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), inputMode: Type.Optional(StringEnum(['ordinary', 'accessibility'] as const)) }, { ...closed, description: 'Optional step record overrides; any field left out is derived from the call.' });
const imageTarget = Type.Union([
  Type.Object({ source: Type.Literal('display'), sessionId: id, executionId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$' }), phase: StringEnum(['before', 'after'] as const) }, closed),
  Type.Object({ source: Type.Literal('application'), name: Type.String({ minLength: 1, maxLength: 101 }), path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, closed),
  Type.Object({ source: Type.Literal('reference'), imageId: Type.String({ pattern: '^image-[a-f0-9]{64}$' }) }, closed),
]);
const language = StringEnum(['shell', 'javascript', 'typescript', 'python'] as const);
const timeoutMs = Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, description: 'Execution timeout in milliseconds, default 120000, maximum 3600000. Independent of snapshot delay and lease TTL.' }));
const runBase = { action: Type.Literal('run'), guest, reason: optionalReason, step: Type.Optional(step), snapshots: Type.Optional(snapshots), timeoutMs };
// Authoritative discriminated contract. Even if a provider only exposes the
// object-shaped projection, every invocation is checked here before dispatch.
export const relayContract = Type.Union([
  Type.Object({ action: Type.Literal('search'), name: Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' }), os: Type.Optional(StringEnum(['linux', 'macos'] as const)) }, closed),
  Type.Object({ action: Type.Literal('acquisition-capabilities') }, closed),
  Type.Object({ action: Type.Literal('console-resolve'), guest }, closed),
  Type.Object({ action: Type.Literal('console-open'), guest, console_id: id, attempt_id: id, userRequested: Type.Literal(true), reason, expected: Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' }) }, closed),
  Type.Object({ action: Type.Literal('console-cancel'), guest, console_id: id, attempt_id: id }, closed),
  Type.Object({ action: Type.Literal('probe'), scope: Type.Optional(StringEnum(['host', 'guest'] as const)), guest: Type.Optional(guest) }, closed),
  Type.Object({ action: Type.Literal('acquire'),
    task: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,35}$' }),
    image: Type.String({ description: 'Image key from relay action=probe, e.g. ubuntu2404 or macos26.' }),
    extractions: Type.Array(Type.Object({ path: Type.String({ description: 'Relative guest-workspace path; no traversal or symlinks.' }), name: Type.String({ description: 'Unique output basename.' }) }, closed), { maxItems: 100 }),
    vnc: Type.Optional(Type.Boolean({ description: 'Prepare guest console sharing, default false. Never opens a viewer automatically.' })),
    ttlHours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 720 })),
    env: Type.Optional(Type.String({ description: 'Credential pack, default none; never baked into images.' })),
    fullWorkspace: Type.Optional(Type.Boolean({ description: 'Explicit opt-in to deliver the entire workspace.' })),
  }, closed),
  Type.Object({ action: Type.Literal('stage'), guest,
    resetRecording: Type.Optional(Type.Boolean({ description: 'Explicitly archive the current recording and start a new session on the same VM. Retains prior evidence; refuses while the receiver lock exists. Use after diagnosing recording damage.' })),
    workspace: Type.Optional(Type.String({ description: 'Host directory copied to the guest workspace, opt-in. It lies in the project folder: relative to it, or absolute inside it; no symlinks.' })),
    files: Type.Optional(Type.Array(Type.Object({ local: Type.String({ description: 'Host file in the project folder: relative to it, or absolute inside it; no symlinks.' }), path: Type.String({ description: 'Relative destination under guest support/.' }) }, closed))),
    nodePath: Type.Optional(Type.String({ description: 'Guest Node executable, default node; use image nvm path if needed.' })),
    cuaDriver: Type.Optional(Type.String({ description: 'Guest CUA executable; OS default when omitted.' })),
  }, closed),
  // The one run branch, relay_script (DC-26): `inline` selects which of `code` and `localPath` the call gives, and `diagnostic` needs `shell`, both checked in validateRelayInput.
  Type.Object({ ...runBase, language,
    inline: Type.Boolean({ description: 'true: the script is `code`, given inline. false: the script is the host file `localPath`. Give exactly the one that inline names.' }),
    code: Type.Optional(Type.String({ maxLength: 1048576, description: 'With inline: true, the script itself, up to 1 MiB.' })),
    localPath: Type.Optional(Type.String({ minLength: 1, description: 'With inline: false, a host script file in the project folder: relative to it, or absolute inside it; no symlinks.' })),
    diagnostic: Type.Optional(Type.Boolean({ description: 'Shell scripts only: explicit diagnosis or repair without screenshot evidence, including before staging. The script and its outcome remain recorded. Never claim visual verification.' })),
  }, closed),
  Type.Object({ action: Type.Literal('image'), guest, target: imageTarget }, closed),
  Type.Object({ action: Type.Literal('extract'), guest, names: Type.Array(Type.String()) }, closed),
  Type.Object({ action: Type.Literal('finish'), guest }, closed),
  Type.Object({ action: Type.Literal('release'), guest }, closed),
]);
// Root object projection keeps common provider tool requirements satisfied;
// anyOf retains the exact closed branches, rather than accepting arbitrary
// combinations of the optional projected properties.
const projected: Record<string, TSchema> = {};
for (const branch of relayContract.anyOf) {
  for (const [key, schema] of Object.entries(branch.properties)) {
    if (key === 'action') continue;
    const previous = projected[key];
    projected[key] = previous && JSON.stringify(previous) !== JSON.stringify(schema)
      ? Type.Optional(Type.Union([previous, schema])) : Type.Optional(schema);
  }
}
const parameterObject = Type.Object({
  action: StringEnum(['search', 'probe', 'acquire', 'stage', 'run', 'image', 'extract', 'finish', 'release', 'acquisition-capabilities', 'console-resolve', 'console-open', 'console-cancel'] as const),
  ...projected,
}, { ...closed, anyOf: relayContract.anyOf, description: 'Select exactly one action. Each closed branch defines allowed fields. Run takes a script; console-open requires reason, expected and userRequested=true. No default action.' });

export type RelayInput = Static<typeof relayContract>;
export const relayParameters = Type.Unsafe<RelayInput>(parameterObject);
export type RelayAction = RelayInput['action'];
export const relayActions = ['search', 'probe', 'acquire', 'stage', 'run', 'image', 'extract', 'finish', 'release', 'acquisition-capabilities', 'console-resolve', 'console-open', 'console-cancel'] as const;
type Branch = (typeof relayContract)['anyOf'][number];
function branchFor(action: RelayAction): Branch {
  const found = relayContract.anyOf.find(branch => (branch.properties as Record<string, any>).action.const === action);
  if (!found) throw new Error(`No contract branch for action ${action}`);
  return found;
}

/**
 * One MCP tool's own input schema, addressed by action: the matching strict
 * branch's plain-object shape with `action` removed, since the tool's own
 * identity already carries it. Always derived fresh from the strict contract
 * above, never hand-copied, so a tool schema can never drift from the branch
 * `relayCall` actually dispatches to.
 */
export function toolInputSchema(action: RelayAction): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(branchFor(action))) as { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  const { action: _action, ...properties } = raw.properties;
  const required = (raw.required ?? []).filter(key => key !== 'action');
  return { type: raw.type, properties, ...(required.length ? { required } : {}), additionalProperties: raw.additionalProperties ?? false };
}

export function validateRelayInput(value: unknown): asserts value is RelayInput {
  if (!Check(relayContract, value)) throw new Error('Invalid relay input: action is required; a call that acts on a guest names it with guest, the name relay_acquire answered; console-open requires nonblank reason. Supply only the fields for the selected action.');
  if (value.action === 'probe' && value.scope === 'guest' && value.guest === undefined) throw new Error('Invalid relay input: relay_probe with scope "guest" names the guest to probe with guest, the name relay_acquire answered.');
  if (value.action === 'run') {
    if (value.diagnostic && value.language !== 'shell') throw new Error('Invalid relay input: only a shell script may be diagnostic, because a diagnostic run goes through vm-service without the receiver.');
    if (value.diagnostic && value.snapshots?.group) throw new Error('Diagnostic scripts cannot join snapshot groups.');
    const given = value.inline ? value.code : value.localPath, other = value.inline ? value.localPath : value.code;
    if (given === undefined || other !== undefined) throw new Error(value.inline
      ? 'Invalid relay input: relay_script with inline: true takes the script as code, and no localPath.'
      : 'Invalid relay input: relay_script with inline: false takes the script file as localPath, and no code.');
  }
}
