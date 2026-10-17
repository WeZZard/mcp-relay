import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The three MCP servers `relay_run` forwards to, in one place: which server a
 * target is, the exact package versions the relay stages for it, how the
 * guest MCP host launches it, and the default wait before the after-snapshot.
 *
 * - `cua` is the guest image's own `cua-driver`, run as `cua-driver mcp` (the
 *   MCP stdio proxy to the Cua Driver daemon). Nothing is staged for it. On
 *   Linux the daemon must already be running as `cua-driver serve --no-overlay`,
 *   the same precondition `relay_exec` calls of `cua-driver call` have.
 * - `playwright` is Playwright MCP (`@playwright/mcp`), headed (its default).
 * - `chrome-devtools` is Chrome DevTools MCP (`chrome-devtools-mcp`), headed
 *   (its default). Page-ID routing, meant for several agents sharing one
 *   browser, is off: one enclosure has one agent, so page-scoped tools keep
 *   their classic shape (the selected page, no required `pageId`).
 *
 * The two browser servers are staged, not fetched in the guest: the host
 * downloads each pinned npm tarball once, checks it against the pinned
 * `sha512` integrity (the value the npm registry publishes), caches it, and
 * pushes it through the same hash-checked transfer `relay_stage` uses. The
 * guest then unpacks the tarballs into one flat `node_modules`. The guest
 * needs no network or npm, and every byte it runs is pinned.
 */
export const TARGETS = ['cua', 'playwright', 'chrome-devtools'] as const;
export type Target = typeof TARGETS[number];

export interface PinnedPackage { name: string; version: string; integrity: string }
export interface TargetPackages { entry: string; packages: PinnedPackage[] }

/** Pinned package closures. Update all three fields together, from `npm view <name>@<version> dist.integrity`. */
export const TARGET_PACKAGES: Record<Exclude<Target, 'cua'>, TargetPackages> = {
  playwright: {
    entry: '@playwright/mcp/cli.js',
    packages: [
      { name: '@playwright/mcp', version: '0.0.82', integrity: 'sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA==' },
      { name: 'playwright', version: '1.64.0-alpha-1789764292000', integrity: 'sha512-3Ngs4ERGdC912uW3srEDtNVey4u1wSaQ/EFcKhxMpz0by0K6nidaJgM087pLpJc1osytiVnL7ack5gvgPArPNw==' },
      { name: 'playwright-core', version: '1.64.0-alpha-1789764292000', integrity: 'sha512-ZgRaybFv4rRy7QMGnYprEGFdNJnvapNqcaER2w96bDQA+40BWIle1el1Yh9KHD3E6XYmieMB+r+UxFTCauTGGQ==' },
    ],
  },
  'chrome-devtools': {
    entry: 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    packages: [
      { name: 'chrome-devtools-mcp', version: '1.10.1', integrity: 'sha512-Klw6HWDqHC/XS1JwZldd2r49aUhbUJN9m9Mvcx4SEueIPXtzuQX+QelxAViobv8YUkDZ7HWDrmViR6LeYK0wAw==' },
    ],
  },
};

/**
 * Default wait, in milliseconds, from the end of a forwarded call to the
 * after-snapshot. The browser servers already wait for the page to settle
 * before they answer (Playwright MCP's own settle wait, Chrome DevTools MCP's
 * navigation and DOM-stability wait), so their default only covers the
 * display catching up with the page. A cua call returns when input is
 * dispatched, so native animations and dialogs get longer. `relay_exec`,
 * `relay_script` and `relay_code` have no idea what they changed on screen
 * and use the cua value. Any call may override with its own interval.
 */
export const DEFAULT_AFTER_INTERVAL_MS: Record<Target | 'command', number> = { cua: 500, playwright: 300, 'chrome-devtools': 300, command: 500 };

/** How the guest MCP host starts one server: an argv, a working directory and extra environment, never a shell string. */
/**
 * `platformArgs` are appended by the guest host on that platform only. Linux
 * guests get `--no-sandbox` for Chromium: Ubuntu 24.04's AppArmor forbids the
 * unprivileged user namespaces the sandbox needs, and the VM is the isolation
 * boundary.
 */
export interface TargetLaunch { command: string; args: string[]; cwd: string; env?: Record<string, string>; platformArgs?: Partial<Record<NodeJS.Platform, string[]>> }
export interface LaunchContext { node: string; cuaDriver: string; packagesRoot: string; workspace: string; outputDir: string; browserExecutable?: string }

/** The launch commands, derived from the pins and the staged paths. */
export function targetLaunches(context: LaunchContext): Record<Target, TargetLaunch> {
  const entry = (target: Exclude<Target, 'cua'>) => join(context.packagesRoot, 'node_modules', TARGET_PACKAGES[target].entry);
  const executable = context.browserExecutable;
  return {
    // On X11 cua-driver's cursor overlay serves screen reads from saved-under
    // pixels it cannot confirm, so display snapshots come back stale or black.
    // The image's own `cua-driver serve` runs with --no-overlay for the same reason.
    cua: { command: context.cuaDriver, args: ['mcp'], cwd: context.workspace, platformArgs: { linux: ['--no-overlay'] } },
    playwright: {
      command: context.node,
      args: [entry('playwright'), '--isolated', '--output-dir', join(context.outputDir, 'playwright', 'files'), ...(executable ? ['--executable-path', executable] : [])],
      cwd: context.workspace,
      platformArgs: { linux: ['--no-sandbox'] },
    },
    'chrome-devtools': {
      command: context.node,
      args: [entry('chrome-devtools'), '--isolated', '--no-usage-statistics', '--no-performance-crux', '--no-page-id-routing', '--workspace', context.workspace, ...(executable ? ['--executablePath', executable] : [])],
      cwd: context.workspace,
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
      platformArgs: { linux: ['--chromeArg=--no-sandbox'] },
    },
  };
}

/** The file name npm gives a package tarball, e.g. `playwright-mcp-0.0.82.tgz`. */
export function tarballName(pin: PinnedPackage): string { return `${pin.name.replace(/^@/, '').replace('/', '-')}-${pin.version}.tgz`; }
/** The registry URL of a pinned tarball. `MCP_RELAY_NPM_REGISTRY` may point at a mirror; the integrity check is the same. */
export function tarballUrl(pin: PinnedPackage, registry = process.env.MCP_RELAY_NPM_REGISTRY ?? 'https://registry.npmjs.org'): string {
  return `${registry.replace(/\/+$/, '')}/${pin.name}/-/${pin.name.split('/').at(-1)}-${pin.version}.tgz`;
}
/** True when `bytes` match an npm `sha512-<base64>` integrity string. */
export function integrityMatches(bytes: Buffer, integrity: string): boolean {
  const [algorithm, expected] = integrity.split('-', 2) as [string, string | undefined];
  return algorithm === 'sha512' && !!expected && createHash('sha512').update(bytes).digest('base64') === expected;
}

export type TarballSource = (pin: PinnedPackage, signal?: AbortSignal) => Promise<Buffer>;
/** Production source: the npm registry over HTTPS. */
export const registrySource: TarballSource = async (pin, signal) => {
  const response = await fetch(tarballUrl(pin), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Fetching ${pin.name}@${pin.version} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/**
 * The verified local path of one pinned tarball: from the host cache when its
 * bytes still match, else fetched from `source`, checked, then published into
 * the cache atomically. A mismatch is never cached and never staged.
 */
export async function cachedTarball(cacheRoot: string, pin: PinnedPackage, source: TarballSource = registrySource, signal?: AbortSignal): Promise<{ path: string; sha256: string }> {
  const path = join(cacheRoot, tarballName(pin));
  try {
    const bytes = await readFile(path);
    if (integrityMatches(bytes, pin.integrity)) return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = await source(pin, signal);
  if (!integrityMatches(bytes, pin.integrity)) throw new Error(`${pin.name}@${pin.version} does not match its pinned integrity; nothing was staged`);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
