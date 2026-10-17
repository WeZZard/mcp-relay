#!/usr/bin/env node
/**
 * Set the release version in package.json, .claude-plugin/plugin.json and
 * the pinned pi-mcp.json arg, refresh the lockfile, rebuild dist/, then
 * commit and tag the release. Never pushes: `git push --follow-tags` is a
 * separate, explicit step (see the README's Releasing section).
 *
 * Usage: node scripts/bump.mjs <X.Y.Z>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Full semver core plus optional pre-release/build metadata (semver.org).
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
}

function fail(message) {
  console.error(`bump: ${message}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) fail('usage: node scripts/bump.mjs <X.Y.Z>');
if (!SEMVER_RE.test(version)) fail(`"${version}" is not a valid semantic version (expected X.Y.Z, e.g. 0.3.0)`);

const status = run('git', ['status', '--porcelain']).trim();
if (status.length > 0) fail('working tree is not clean; commit or stash pending changes before bumping');

const packageJsonPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
pkg.version = version;
writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');

const pluginJsonPath = join(ROOT, '.claude-plugin/plugin.json');
const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
plugin.version = version;
writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + '\n');

const piMcpPath = join(ROOT, 'pi-mcp.json');
const piMcpBefore = readFileSync(piMcpPath, 'utf8');
const piMcpAfter = piMcpBefore.replace(/@wezzard\/mcp-relay@[^"]+/, `@wezzard/mcp-relay@${version}`);
if (piMcpAfter === piMcpBefore) fail('pi-mcp.json did not contain a @wezzard/mcp-relay@<version> pin to update');
writeFileSync(piMcpPath, piMcpAfter);

run('npm', ['install', '--package-lock-only']);
run('npm', ['run', 'build']);

run('git', ['add', 'package.json', 'package-lock.json', '.claude-plugin/plugin.json', 'pi-mcp.json', 'dist']);
run('git', ['commit', '-m', `Release v${version}`]);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);

console.log(`bump: committed and tagged v${version} (not pushed — run: git push --follow-tags)`);
