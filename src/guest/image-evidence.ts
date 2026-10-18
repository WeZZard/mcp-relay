import type { FramedRequest } from "@wezzard/relay-driver-host-sdk";

/**
 * The saved-image contract a receipt carries: written by the guest receiver
 * and validated again by the host image store before any descriptor is used
 * as a path. It lives apart from the receiver so the host bundles carry none
 * of the guest program, in particular not its command-line entry.
 */
/**
 * `capture: false` is a run on an image that lists no capture software
 * (cua-driver): it takes no snapshots, and their absence is not a gap
 * (docs/guest-code-runs.md §3). Absent means capture, as before.
 */
/**
 * The request the guest receives: a script, given inline as `code` or as an
 * uploaded `remotePath`, with no kind (DC-26). The SDK's `kind` and `argv`
 * may still be present; the receiver reads neither.
 */
export type GuestRequest = Omit<FramedRequest, "kind" | "language"> & { readonly kind?: string; readonly language?: "shell" | "javascript" | "typescript" | "python"; readonly because: string; readonly timeoutMs?: number; readonly diagnostic?: boolean; readonly capture?: boolean };

export const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);

export interface GuestSnapshotDescriptor {
  sessionId: string;
  attemptId: string;
  executionId: string;
  actionId: string;
  stepId?: string;
  phase: "before" | "after";
  capturedAt: string;
  sha256: string;
  bytes: number;
  mimeType: "image/png";
  declaredAfterIntervalMs?: number;
  fileName: string;
  groupId?: string;
}
export interface GuestImageEvidence {
  /** Availability of this execution's after phase, not its execution outcome. */
  status: "available" | "not-requested" | "capture-failed" | "capture-unknown";
  snapshots: GuestSnapshotDescriptor[];
}

export function afterRequested(request: GuestRequest): boolean {
  return request?.diagnostic !== true && request?.capture !== false &&
    !["first", "member"].includes(request?.snapshots?.group?.phase ?? "");
}

/** Validate untrusted receipt metadata before using any descriptor as a path. */
export function validateImageEvidence(value: unknown, request: GuestRequest, authoritativeSnapshots?: readonly GuestSnapshotDescriptor[]): asserts value is GuestImageEvidence {
  const fail = (): never => { throw new Error("invalid image evidence"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const evidence = value as GuestImageEvidence;
  if (!["available", "not-requested", "capture-failed", "capture-unknown"].includes(evidence.status) || !Array.isArray(evidence.snapshots) || evidence.snapshots.length > 2) fail();
  const group = request.snapshots?.group;
  const phases = new Set<string>();
  let actionId: string | undefined;
  for (const s of evidence.snapshots) {
    if (!s || typeof s !== "object" || Array.isArray(s) ||
        s.sessionId !== request.sessionId || s.attemptId !== request.attemptId || s.executionId !== request.executionId ||
        !safeId(s.actionId) || s.stepId !== request.step?.id || s.groupId !== group?.groupId ||
        !["before", "after"].includes(s.phase) || phases.has(s.phase) ||
        (actionId !== undefined && actionId !== s.actionId) ||
        typeof s.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.capturedAt) || !Number.isFinite(Date.parse(s.capturedAt)) ||
        typeof s.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.sha256) ||
        !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.bytes > 64 * 1024 * 1024 ||
        s.mimeType !== "image/png" || typeof s.fileName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/.test(s.fileName) || s.fileName.length > 255 ||
        (request.diagnostic === true) || request.capture === false ||
        (s.phase === "before" && group && group.phase !== "first") ||
        (s.phase === "after" && !afterRequested(request)) ||
        s.declaredAfterIntervalMs !== (s.phase === "after" ? group?.afterIntervalMs ?? request.snapshots?.afterIntervalMs : undefined)) fail();
    phases.add(s.phase); actionId = s.actionId;
  }
  if ((evidence.status === "not-requested") !== !afterRequested(request) ||
      (evidence.status === "available") !== phases.has("after")) fail();
  if (authoritativeSnapshots !== undefined) {
    if (authoritativeSnapshots.length !== evidence.snapshots.length) fail();
    const fields = ["sessionId", "attemptId", "executionId", "actionId", "stepId", "phase", "capturedAt", "sha256", "bytes", "mimeType", "declaredAfterIntervalMs", "fileName", "groupId"] as const;
    for (const s of evidence.snapshots) {
      const original = authoritativeSnapshots.find(record => record.phase === s.phase);
      if (!original || fields.some(field => original[field] !== s[field])) fail();
    }
  }
}

