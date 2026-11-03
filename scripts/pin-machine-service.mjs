// Pin the machine-service commit CI builds machctl from (DC-65).
//
//   npm run pin:machine-service            # the default branch's head
//   npm run pin:machine-service -- <sha>   # a named commit
//
// CI checks out exactly the commit in .github/machine-service.commit, so a
// change on machine-service's default branch reaches mcp-relay's CI only when
// a commit here moves the pin.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// machine-service's repository, under its name before the rename.
const REPOSITORY = 'https://github.com/WeZZard/vm-service';
const PIN = fileURLToPath(new URL('../.github/machine-service.commit', import.meta.url));
const named = process.argv[2];
const commit = named ?? execFileSync('git', ['ls-remote', REPOSITORY, 'HEAD'], { encoding: 'utf8' }).split(/\s/)[0];
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`Not a full commit SHA: ${JSON.stringify(commit)}`);
writeFileSync(PIN, `${commit}\n`);
console.log(`machine-service pinned at ${commit}`);
