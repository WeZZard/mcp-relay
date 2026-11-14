/** Types for replace-on-success.mjs, which the build imports as plain JavaScript. */
export function replaceOnSuccess(target: string, build: (staged: string) => Promise<void>): Promise<void>;
