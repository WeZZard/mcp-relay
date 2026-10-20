// Bounded real integration: one explicit selected image, public tool, production HTTP only.
import { setupSelectedCloneX11 } from './selected-image-x11.js';
import { supportArgument, verifySupportDriver } from './selected-image-support.js';
import { RelayManager } from '../src/manager.js';
import { relayCall } from '../src/surface.js';
import { MachineService, MachineServiceError } from '../src/machine-service.js';
import { verifyDeliveredPackage } from '../src/package.js';
import { verifyPackage } from '@wezzard/relay-driver-host-sdk';
import { mkdir, readFile, writeFile, readdir, lstat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const project=resolve(import.meta.dirname,'..');
if(!process.argv.includes('--run'))throw Error('Explicit --run required');
const supportPath=supportArgument(process.argv.slice(2));
// Validate before creating evidence or making any service call. No implicit fallback.
const support=supportPath?await verifySupportDriver(project,supportPath):undefined;
const root=join(project,'test-evidence','selected-image-lifecycle-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(join(root,'audit'),{recursive:true});
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const save=async(n:string,v:unknown)=>writeFile(join(root,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
let seq=0;
async function audit<T>(kind:string,input:unknown,fn:()=>Promise<T>):Promise<T>{const n=String(seq++).padStart(4,'0'),at=new Date().toISOString();try{const result=await fn();await save(`audit/${n}-${kind}.json`,{at,endedAt:new Date().toISOString(),input,result});return result;}catch(e){await save(`audit/${n}-${kind}.json`,{at,endedAt:new Date().toISOString(),input,error:String(e),stack:(e as Error).stack});throw e;}}
// Transparent observation of the existing MachineService HTTP implementation; no alternative execution channel.
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const url=String(input);assert(url.startsWith('http://127.0.0.1:6240/'));return audit('http',{url,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined},async()=>{const response=await fetchOriginal(input,init);const bytes=await response.clone().text();await save(`http-response-${seq++}.json`,{url,status:response.status,body:bytes});return response;});};
const vm=new MachineService({baseUrl:'http://127.0.0.1:6240',acquireTimeoutMs:420000});
const manager=new RelayManager({sessionId:'selected-image-'+Date.now(),project,vm,stateRoot:join(root,'state'),outputRoot:join(root,'packages'),heartbeatMs:3000});
let lease:any,finished=false,failed:unknown,before:any;
const call=async(input:any)=>audit('public-'+input.action,input,async()=>{const r=await relayCall(manager,input);return r.details??JSON.parse(r.text);});
const tart=()=>JSON.parse(execFileSync('tart',['list','--format','json'],{encoding:'utf8',timeout:15000}));
async function fingerprints(){const out:any={formula:'file metadata fingerprint = device,inode,size,mtimeNs; config/nvram SHA256; not disk-content hash',bases:{}};for(const base of ['pilot-ubuntu-base','pilot-macos26-base']){const files:any={};for(const f of ['config.json','disk.img','nvram.bin']){const path=join(process.env.HOME!,'.tart/vms',base,f);const s=await lstat(path,{bigint:true});files[f]={dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),...(f==='disk.img'?{}:{sha256:sha(await readFile(path))})};}out.bases[base]=files;}return out;}
const guest=async(argv:string[])=>{const r=await audit('guest-setup',{argv},()=>vm.exec(lease.vm,{argv,timeout:60}));if(r.rc!==0)throw Error(`Guest setup rc=${r.rc}: ${r.output}`);return r.output;};
try{
 const selectedPath=join(project,'test-evidence/catalog-candidate-check/2026-09-13T17-05-26-088Z/firefox.json');const bytes=await readFile(selectedPath),search=JSON.parse(bytes.toString());
 const selected=search.applications.find((x:any)=>x.name==='Firefox').installations.find((x:any)=>x.image==='ubuntu2404');assert(selected);
 await save('selection.json',{selectedPath,sha256:sha(bytes),actualSelection:'ubuntu2404',installation:selected,policy:'Explicit selection from retained parent-verified result; no new search, install or automatic selection'});
 await save('source-hashes.json',await Promise.all(['scripts/selected-image-lifecycle.ts','scripts/selected-image-support.ts','scripts/selected-image-x11.ts','scripts/live-smoke-x11.ts','scripts/live-smoke-display.cjs','src/surface.ts','src/schema.ts','src/manager.ts','src/machine-service.ts','src/transport.ts','src/package.ts','dist/server.mjs'].map(async p=>({path:p,sha256:sha(await readFile(join(project,p)))}))));
 before=await fingerprints();await save('base-before.json',before);await save('tart-before.json',tart());
 await call({action:'probe'});
 await save('scope.json',{nonUI:true,video:'not applicable',visualBehavior:'not tested',purpose:'Explicitly requested integration test of actual selected-image lifecycle; no host/guest pointer, keyboard or application launch'});
 lease=await call({action:'acquire',task:'selected-image-lifecycle',image:'ubuntu2404',env:'none',ttlHours:0.25,extractions:[{path:'result.json',name:'result.json'}]});
 await save('acquired.json',lease);
 const registry=await readFile(manager.registry.path,'utf8');const row=registry.split('\n').filter(l=>l.includes(lease.purpose));assert.equal(row.length,1);await save('registered.json',{path:manager.registry.path,row});
 // Default remains installed-only; retained support requires explicit verified opt-in.
 if(support)await save('support-provenance.json',support.provenance);
 const discovery=await guest(['/bin/bash','-lc','printf "NODE="; command -v node || true; printf "CUA="; command -v cua-driver || true; printf "KNOWN_PATHS\\n"; for p in "$HOME/.local/bin/cua-driver" /usr/local/bin/cua-driver /usr/bin/cua-driver /opt/cua-driver/cua-driver; do if test -x "$p"; then printf "%s\\n" "$p"; fi; done']);
 await save('runtime-discovery.json',{output:discovery});
 const node=discovery.match(/^NODE=(\/[^\r\n]+)/m)?.[1];const installedDriver=discovery.match(/^CUA=(\/[^\r\n]+)/m)?.[1]??discovery.split('KNOWN_PATHS\n')[1]?.trim().split('\n')[0];
 const driver=support?lease.guestRoot+'/support/cua-driver':installedDriver;
 assert(node,'Installed guest Node executable not found');assert(driver?.startsWith('/'),'Installed guest cua-driver not found; no installation or image repair permitted');
 await guest([node,'--version']);if(!support)await guest([driver,'--version']);
 await setupSelectedCloneX11(node,guest,save);
 const displayCode=await readFile(join(project,'scripts/live-smoke-display.cjs'),'utf8');
 // Up to 7 read-only samples / 30s total, 2s between empty samples. Each
 // command remains capped at 3s (and remaining budget); outer guest cap is 60s.
 // Explicit clone-only X11 setup completed above; discovery itself is read-only.
 // No retries of failed connections or uncertain setup operations.
 const displayOutput=await guest([node,'-e',displayCode+'\nobserveDetailed({timeoutMs:30000,maxAttempts:7,intervalMs:2000,retain:entry=>console.log(JSON.stringify({sample:entry}))}).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(String(e));process.exitCode=1;});']);
 const report=JSON.parse(displayOutput.trim().split('\n').at(-1)!);
 for(const sample of report.samples)await save(`display-discovery-${sample.attempt}.json`,sample);
 await save('display-discovery.json',report);
 if(report.status!=='ready')throw Error(`${report.status}: ${report.status==='unsupported-session-type'
  ? 'Successful Wayland/Xwayland connection is unsupported; this screenshot test requires native X11'
  : report.status==='connection-failed'?'Graphical candidate xrandr connection failed; not replayed'
  : 'No native X11 session became ready within discovery bounds'}; see display-discovery.json`);
 const display=report.selected;
 // Environment-only wrapper calls the real driver; never fakes doctor or snapshots.
 const wrapper=join(root,'cua-wrapper');const text=`#!/bin/sh\nexec /usr/bin/env ${Object.entries(display.env).map(([k,v])=>`${k}='${String(v).replaceAll("'","'\\''")}'`).join(' ')} '${driver}' "$@"\n`;
 await writeFile(wrapper,text,{flag:'wx',mode:0o755});await chmod(wrapper,0o755);
 const files=[{local:wrapper,path:'cua-wrapper'}];
 if(support){
  // Immutable attempt-local copy: never chmod or rewrite the historical artifact.
  const local=join(root,'cua-driver');await writeFile(local,support.bytes,{flag:'wx',mode:0o755});
  files.unshift({local,path:'cua-driver'});
 }
 await save('declared-inputs.json',{files:await Promise.all(files.map(async f=>({...f,sha256:sha(await readFile(f.local)),bytes:(await lstat(f.local)).size,destination:lease.guestRoot+'/support/'+f.path}))),runtime:{node,driver},result:{path:'result.json',name:'result.json'}});
 // Current manager.stage transfers files before starting a local SDK session; no doctor is invoked.
 // Therefore no pre-stage bootstrap transfer is needed. Serve only after verified stage delivery.
 await call({action:'stage',nodePath:node,cuaDriver:lease.guestRoot+'/support/cua-wrapper',files});
 if(support)await guest([driver,'--version']);
 await guest([node,'-e',`const fs=require('fs'),cp=require('child_process');fs.mkdirSync(${JSON.stringify(lease.guestRoot)},{recursive:true});const fd=fs.openSync(${JSON.stringify(lease.guestRoot+'/cua.log')},'a');const p=cp.spawn(${JSON.stringify(driver)},['serve','--no-overlay'],{env:{...process.env,...${JSON.stringify(display.env)}},detached:true,stdio:['ignore',fd,fd]});p.unref();console.log(JSON.stringify({pid:p.pid}));`]);
 // Bounded read-only daemon readiness observation. Do not replay serve or repair on failure.
 await guest([node,'-e',`const fs=require('fs');setTimeout(()=>{if(!fs.existsSync(require('path').join(require('os').homedir(),'.cache/cua-driver/cua-driver.sock')))throw Error('Driver socket unavailable after 500ms');console.log('Driver socket exists; first snapshot remains authoritative');},500);`]);
 const expected={test:'selected-image-lifecycle',image:'ubuntu2404',selectionSha256:sha(bytes),nonUI:true};const output=JSON.stringify(expected)+'\n';
 await save('expected-output.json',{value:expected,bytes:Buffer.byteLength(output),sha256:sha(output)});
 await call({action:'run',reason:'Verify the explicitly selected Ubuntu image through one real non-UI Node execution and checksummed declared output; no visual behavior or media test.',language:'javascript',inline:true,code:`require('fs').writeFileSync('result.json',${JSON.stringify(output)},{flag:'wx'});console.log('declared result written');`,step:{id:'write-result',title:'Write declared result with installed Node',expected:'Node exits zero and writes exact declared JSON bytes; desktop snapshots are evidence only, not a visual assertion.',inputMode:'ordinary'},snapshots:{afterIntervalMs:0}});
 const delivery:any=await call({action:'finish'});finished=true;await save('finish.json',delivery);
 const packageRoot=dirname(delivery.manifestPath);const manifest=JSON.parse(await readFile(delivery.manifestPath,'utf8'));
 const verification=await verifyPackage(manifest,packageRoot);await save('sdk-package-verification.json',verification);
 assert(verification.findings.every((f:any)=>f.code==='ok'),'SDK verifyPackage findings');
 await save('package-verification.json',await verifyDeliveredPackage(packageRoot));assert.equal(delivery.snapshots,'complete');assert.equal(delivery.execution,'passed');assert.equal(manifest.snapshots.length,2);
 const attachment=manifest.attachments.find((a:any)=>a.path.startsWith('extractions/result.json/'));assert(attachment);const actual=await readFile(join(packageRoot,attachment.path));assert.equal(sha(actual),sha(output));assert.deepEqual(JSON.parse(actual.toString()),expected);
 await save('output-verified.json',{path:join(packageRoot,attachment.path),sha256:sha(actual),matchesExpected:true});
}catch(e){failed=e;await save('error.json',{error:String(e),stack:(e as Error).stack,status:manager.status()});}
finally{
 if(!finished)try{await call({action:'release'});}catch(e){await save('release-error.json',{error:String(e)});failed??=e;}
 try{await manager.cleanup('Selected-image integration enclosure ended');}catch(e){await save('cleanup-error.json',{error:String(e)});failed??=e;}
 try{
 const list=await vm.list();let status:number|undefined;if(lease)try{await vm.get(lease.vm);status=200;}catch(e){if(e instanceof MachineServiceError)status=e.status;else throw e;}
 const inventory=tart(),registry=await readFile(manager.registry.path,'utf8'),after=await fingerprints();await save('base-after.json',after);
 const cleanup={manager:manager.status(),registryPath:manager.registry.path,registryRemoved:lease?!registry.includes(lease.purpose):null,httpStatus:status,serviceAbsent:lease?!Object.hasOwn(list.machines,lease.vm):null,tartAbsent:lease?!inventory.some((v:any)=>v.Name===lease.vm):null,baseUnchanged:JSON.stringify(before)===JSON.stringify(after),service:list,tart:inventory};await save('cleanup.json',cleanup);
 assert(cleanup.baseUnchanged);if(lease){assert(cleanup.registryRemoved);assert.equal(status,404);assert(cleanup.serviceAbsent);assert(cleanup.tartAbsent);}
 }catch(e){failed??=e;await save('cleanup-verification-error.json',{error:String(e)});}
 await save('summary.json',{outcome:failed?'blocked-or-failed':'passed',error:failed?String(failed):undefined,finished,lease,nonUI:true,media:'not tested / not required',visualBehavior:'not tested',humanReview:'pending',evidenceRoot:root});
 const hashes:any[]=[];async function walk(p:string){for(const e of await readdir(join(root,p),{withFileTypes:true})){const rel=join(p,e.name);if(e.isDirectory())await walk(rel);else if(e.isFile())hashes.push({path:rel,sha256:sha(await readFile(join(root,rel)))});}}await walk('');await save('audit-hashes.json',{formula:'SHA256 of original file bytes; audit-hashes.json excludes itself',files:hashes});
 console.log(JSON.stringify({root,outcome:failed?'blocked-or-failed':'passed',error:failed?String(failed):undefined}));if(failed)process.exitCode=1;
}
