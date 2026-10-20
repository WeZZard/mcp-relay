import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installationReport } from '../src/doctor.js';
import { Registry } from '../src/registry.js';
import { MachineService } from '../src/machine-service.js';

test('doctor checks shipped hashes and read-only prerequisites without acquisition or input',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-doctor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registry=new Registry({env:{},home:root});
 const vm=new MachineService({baseUrl:'http://127.0.0.1:1'});
 t.mock.method(vm,'health',async()=>({ok:true,service:'machine-service'}));
 t.mock.method(vm,'images',async()=>({images:{ubuntu2404:{kind:'linux',base:'fixture',base_available:true}},capacity:{}} as any));
 t.mock.method(vm,'list',async()=>({machines:{}} as any));
 t.mock.method(vm,'acquire',async()=>assert.fail('doctor must not allocate'));
 const commands:string[][]=[];
 const run=async(argv:readonly string[])=>{commands.push([...argv]);return{code:0,stdout:argv[0]==='tart'?'[]':'3.14',stderr:''};};
 const r=await installationReport({assetsDir:resolve('dist'),registry,vm,run});
 assert.equal(r.checks.find(c=>c.name==='runtime-bundles')?.ok,true);
 assert.equal(r.checks.find(c=>c.name==='machine-service')?.ok,true);
 assert.equal(r.checks.find(c=>c.name==='registry')?.ok,true);
 assert.equal(commands.length,2);assert.deepEqual(commands[1],['tart','list','--format','json']);
 assert.equal(r.ready,process.platform==='darwin'&&process.arch==='arm64');
 // A service still answering as vm-service is refused, naming what to install (DC-27).
 t.mock.method(vm,'health',async()=>({ok:true,service:'vm-service'}));
 const renamed=await installationReport({assetsDir:resolve('dist'),registry,vm,run});
 assert.equal(renamed.ready,false);assert.match(renamed.checks.find(c=>c.name==='machine-service')!.detail,/answers as "vm-service", not machine-service/);
 t.mock.method(vm,'health',async()=>{throw Error('backend unavailable');});
 const unavailable=await installationReport({assetsDir:root,registry,vm,run});
 assert.equal(unavailable.ready,false);assert.equal(unavailable.checks.find(c=>c.name==='runtime-bundles')?.ok,false);assert.match(unavailable.checks.find(c=>c.name==='machine-service')!.detail,/backend unavailable/);
});

test('doctor rejects corrupt existing managed registry instead of reporting readiness',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-doctor-registry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registry=new Registry({env:{MCP_RELAY_STATE_DIR:root},home:root});
 await writeFile(registry.path,'not a registry');
 const vm=new MachineService({baseUrl:'http://127.0.0.1:1'});t.mock.method(vm,'health',async()=>{throw Error('offline fixture');});
 const r=await installationReport({registry,vm,run:async()=>({code:0,stdout:'[]',stderr:''})});
 assert.equal(r.ready,false);assert.equal(r.checks.find(c=>c.name==='registry')?.ok,false);
});
