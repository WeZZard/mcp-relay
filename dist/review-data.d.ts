export interface CommandOutput {
    exit?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    stdout?: string;
    stderr?: string;
}
/** Evidence about a step that the trajectory does not carry as fields. */
export interface StepDetail {
    /** When the step started: the action start, or the diagnostic request. */
    at?: string;
    beforeAt?: string;
    afterAt?: string;
    /** The guest command, exactly as requested. */
    argv?: string[];
    output?: CommandOutput;
}
export interface ReviewPageStep {
    id: string;
    title: string;
    execution: string;
    state: string;
    inputMode: string;
    because?: string;
    expected?: string;
    observed?: string;
    snapshots?: {
        before?: string;
        after?: string;
        groupId?: string;
        declaredAfterIntervalMs?: number;
    };
}
/** A plain-words reason for a verdict that is not complete or passed, with the steps it concerns and what the reader can do. */
export interface Reason {
    text: string;
    stepIds: string[];
    action?: string;
}
/** A package's review data: JSON, with the details keyed by step id. */
export interface ReviewData {
    packageId: string;
    sessionId: string;
    taskId: string;
    completeness: string;
    execution: string;
    findings: string[];
    /** Why each verdict is not complete or passed, and the relay's own defects, which change no verdict. */
    reasons: {
        snapshots: Reason[];
        execution: Reason[];
        defects?: Reason[];
    };
    steps: ReviewPageStep[];
    details: Record<string, StepDetail>;
    /** Declared extractions, by package path. */
    outputs: {
        path: string;
        bytes: number;
    }[];
    /** The package's own files, by package path: its seal, its opening note, and an earlier relay's derived files. */
    files: {
        path: string;
        bytes: number;
    }[];
}
/** The steps, verdicts and reasons of the package in `dir`, with each step's snapshots as package paths. */
export declare const reviewData: (dir: string) => Promise<ReviewData>;
