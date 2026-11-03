import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { supportArgument, verifySupportDriver, DRIVER_SHA256 } from './selected-image-support.js';
const project=resolve(import.meta.dirname,'..');
test('support is opt-in and malformed flags fail closed',()=>{
 assert.equal(supportArgument(['--run']),undefined);
 assert.equal(supportArgument(['--support-driver','a']),resolve('a'));
 assert.throws(()=>supportArgument(['--support-driver']));
 assert.throws(()=>supportArgument(['--support-driver','--run']));
 assert.throws(()=>supportArgument(['--support-driver','a','--support-driver','b']));
});
test('retained ARM64 bytes match manifest-authenticated historical stage event',async()=>{
 const verified=await verifySupportDriver(project,resolve(project,'test-evidence/ubuntu-20260912-2127/cua-driver'));
 assert.equal(verified.provenance.sha256,DRIVER_SHA256);
 await assert.rejects(verifySupportDriver(project,resolve(project,'package.json')));
});
test('offline ordering contract: stage copies support before SDK start; SDK start does not doctor',async()=>{
 const manager=await readFile(resolve(project,'src/manager.ts'),'utf8');
 const stage=manager.slice(manager.indexOf('  stage(input:'),manager.indexOf('  run(input:'));
 assert(stage.indexOf('for (const file of input.files')<stage.indexOf('relay.start('));
 assert(!stage.includes('doctor'));
 const sdk=await readFile(resolve(project,'node_modules/@wezzard/relay-driver-host-sdk/dist/src/relay.js'),'utf8');
 const start=sdk.slice(sdk.indexOf('async start('),sdk.indexOf('async attach('));
 assert(!start.includes('doctor')); assert(!start.includes('.send('));
 const script=await readFile(resolve(project,'scripts/lifecycle.ts'),'utf8');
 assert(script.indexOf("action: 'stage'")<script.indexOf("['serve','--no-overlay']"));
 assert(!script.includes('dangerously-bypass'));
 assert(!script.includes('new Transfer('));
 assert(script.includes("if (!support) await guest([driver, '--version'])"));
});
