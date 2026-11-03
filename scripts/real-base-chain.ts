// The real-base chain: a candidate catalog bound to the real base, a public
// search through it, and the production lifecycle on the image it selects,
// with the clone's installation facts compared to the sealed historical
// inventory before any guest setup (DC-7x-LIVE-2).
//
//   tsx scripts/real-base-chain.ts --run --instance <root> --tart <path> --support-driver <path>
//
// It drives a second instance, as scripts/lifecycle.ts says, started with its
// catalog under its own root: `second-instance start … --tart-home <store>
// --env PILOT_REPO=<root>/candidate/pilot --env
// PILOT_IMAGES_STATE_DIR=<root>/candidate/image-state`. Under pilot-images'
// maintenance lock on ubuntu2404, scripts/real-base-candidate.py checks the
// sealed original evidence against the base in the instance's store, binds
// the candidate catalog into those two folders and holds the lock until this
// script stops it. The instance serves the catalog itself; no proxy, no
// installed instance, no rewritten source.
import { readFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { supportArgument, verifySupportDriver } from './selected-image-support.js';
import { closeLiveRun, openLiveRun, project, runLifecycle, sha, type LifecycleContext } from './lifecycle.js';
import { canonicalPath, ownedFolder } from './second-instance.mjs';
import { relayCall } from '../src/surface.js';

const IMAGE = 'ubuntu2404';
const pilotSource = join(project, '../pilot-images');
const original = join(project, 'test-evidence/real-installed-inventory-20260913T164629Z');

/** The clone's installation facts, collected before any setup, equal the sealed historical inventory. */
async function observeInventory({ run, guest, lease }: LifecycleContext) {
  const { save, audit, vm } = run;
  const sealed = JSON.parse(await readFile(join(original, 'sha256.json'), 'utf8'));
  for (const p of ['collect.py', 'aliases.json', `${IMAGE}/raw-inventory.json`]) assert.equal(sha(await readFile(join(original, p))), sealed[p]);
  const observationRoot = lease.guestRoot + '/original-observation';
  await guest(['/bin/mkdir', '-p', '-m', '700', observationRoot]);
  for (const name of ['collect.py', 'aliases.json']) await audit('original-input-push', { name }, () => vm.push(lease.vm, { local_path: join(original, name), remote_path: observationRoot + '/' + name }));
  const checkCode = 'import hashlib,json; from pathlib import Path; p=Path(' + JSON.stringify(observationRoot) + '); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ["collect.py","aliases.json"]}))';
  const inputHashes = JSON.parse((await guest(['python3', '-c', checkCode])).trim());
  assert.equal(inputHashes['collect.py'], sealed['collect.py']); assert.equal(inputHashes['aliases.json'], sealed['aliases.json']); await save('guest-original-input-hashes.json', inputHashes);
  const collectorCommand = ['/bin/bash', '-lic', 'python3 ' + observationRoot + '/collect.py --aliases ' + observationRoot + '/aliases.json > ' + observationRoot + '/inventory.json'];
  await save('immediate-collector-command.json', { argv: collectorCommand, ordering: 'before GDM/support changes' });
  await guest(collectorCommand);
  const digestOutput = (await guest(['python3', '-c', 'import hashlib; print(hashlib.sha256(open(' + JSON.stringify(observationRoot + '/inventory.json') + ',"rb").read()).hexdigest())'])).trim();
  const immediatePath = join(run.root, 'immediate-inventory.json');
  await audit('immediate-inventory-pull', { remote: observationRoot + '/inventory.json' }, () => vm.pull(lease.vm, { remote_path: observationRoot + '/inventory.json', local_path: immediatePath }));
  const immediate = await readFile(immediatePath); assert.equal(sha(immediate), digestOutput);
  const canonical = (inv: any) => ({ schemaVersion: inv.schemaVersion, os: inv.os, architecture: inv.architecture, sources: [...inv.sources].sort((a, b) => a.id.localeCompare(b.id)), applications: inv.applications.map((a: any) => ({ ...a, aliases: [...a.aliases].sort() })).sort((a: any, b: any) => a.id.localeCompare(b.id)) });
  const historical = canonical(JSON.parse(await readFile(join(original, `${IMAGE}/raw-inventory.json`), 'utf8'))), observed = canonical(JSON.parse(immediate.toString()));
  const equality = JSON.stringify(historical) === JSON.stringify(observed);
  await save('inventory-equality.json', { equal: equality, formula: 'sort applications by id and aliases, sources by id; compare every installation/source/platform field; exclude only collectedAt', historicalSha256: sha(JSON.stringify(historical)), immediateSha256: sha(JSON.stringify(observed)), notAttestation: true, notBootUpdatePrevention: true });
  // Read-only update activity, retain exact command exits within successful observer.
  const updateScript = 'import subprocess,json; commands=[["systemctl","list-timers","--all","--no-pager"],["systemctl","is-active","apt-daily.service","apt-daily-upgrade.service","unattended-upgrades.service","snapd.service"],["ps","-eo","pid,lstart,args"],["journalctl","-b","--no-pager","-u","apt-daily.service","-u","apt-daily-upgrade.service","-u","unattended-upgrades.service","-u","snapd.service","-n","150"]]; out=[]\nfor cmd in commands:\n r=subprocess.run(cmd,capture_output=True,text=True,timeout=15); out.append(dict(argv=cmd,rc=r.returncode,stdout=r.stdout,stderr=r.stderr))\nprint(json.dumps(out))';
  await save('update-activity.json', JSON.parse(await guest(['python3', '-c', updateScript])));
  if (!equality) { await save('inventory-difference.json', { historical, observed }); throw Error('Immediate installation facts mismatch; stop before support/GDM; release, no equivalence claim'); }
}

const args = process.argv.slice(2);
if (!args.includes('--run')) throw Error('Explicit --run required');
const supportPath = supportArgument(args);
if (!supportPath) throw Error('--support-driver <path> is required');
const support = await verifySupportDriver(project, supportPath);
// The catalog the instance reads lies under its own root, so the candidate
// binds nothing the operator or the installed instance reads.
let catalog!: { pilotRepo: string; imageState: string };
const run = await openLiveRun('real-base-chain', args, instance => { catalog = { pilotRepo: ownedFolder(instance, 'PILOT_REPO'), imageState: ownedFolder(instance, 'PILOT_IMAGES_STATE_DIR') }; });
await cp(original, join(run.root, 'original'), { recursive: true });
await mkdir(join(run.root, 'candidate'));
await run.save('command.json', { argv: process.argv, scope: 'one fresh clone of the second instance, nonUI no video; no production publication/deploy/restart; human review pending' });
const child = spawn('python3', ['-u', join(pilotSource, 'host/maintenance-lock.py'), 'acquire', IMAGE, 'python3', '-u', join(project, 'scripts/real-base-candidate.py'), project, original, join(run.root, 'candidate'), run.instance.root, run.tartPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
let stderr = ''; child.stderr.on('data', b => stderr += b); let exited = false;
const childExit = new Promise<any>(res => child.once('exit', (code, signal) => { exited = true; res({ code, signal }); }));
const readyPromise = new Promise<any>((res, rej) => { const timer = setTimeout(() => rej(Error('candidate startup timeout')), 30000); createInterface({ input: child.stdout }).once('line', s => { clearTimeout(timer); try { res(JSON.parse(s)); } catch (e) { rej(e); } }); child.once('exit', code => { clearTimeout(timer); rej(Error('candidate startup exit ' + code)); }); });
let failed: unknown;
try {
  const ready = await readyPromise; assert(ready.ready); await run.save('candidate-ready.json', ready);
  assert.equal(ready.pilotRepo, catalog.pilotRepo); assert.equal(ready.imageState, catalog.imageState);
  failed = await runLifecycle(run, {
    sources: ['scripts/real-base-chain.ts', 'scripts/real-base-candidate.py', 'scripts/real-base-candidate.test.py'],
    async select({ manager }) {
      // The instance serves the candidate's line for the image, from its own catalog.
      const images: any = await run.vm.images();
      await run.save('instance-images.json', images);
      assert.equal(canonicalPath(images.images[IMAGE].source), join(catalog.pilotRepo, 'images', IMAGE, 'line.conf'));
      const response = await relayCall(manager, { action: 'search', name: 'Firefox', os: 'linux' });
      const bytes = Buffer.from(response.text); await writeFile(join(run.root, 'original-search-result.json'), bytes, { flag: 'wx' });
      const search: any = response.details ?? JSON.parse(response.text);
      const installation = search.applications.find((x: any) => x.name === 'Firefox')?.installations.find((x: any) => x.os === 'linux');
      assert(installation); assert.equal(installation.image, IMAGE);
      return { image: installation.image, bytes, record: { image: installation.image, installation, sha256: sha(bytes), source: 'this attempt actual candidate public search result', composition: 'candidate discovery / production lifecycle' } };
    },
    afterAcquire: observeInventory,
  }, support);
  // The one acquisition asked for the image the search selected.
  const acquires = run.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/acquire');
  if (!failed) {
    assert.equal(acquires.length, 1); assert.equal((acquires[0]!.body as any).image, IMAGE);
    await run.save('selection-acquire-equality.json', { equal: true, selectedImage: IMAGE, acquisitionRequest: acquires[0]!.body });
  }
} catch (e) { failed ??= e; await run.save('failure.json', { error: String(e) }); }
finally {
  if (!exited) child.stdin.end('stop\n'); const exit = await childExit; await run.save('candidate-command-exit.json', { ...exit, stderr }); if (exit.code !== 0) failed ??= Error('candidate nonzero');
  await closeLiveRun(run, failed);
}
