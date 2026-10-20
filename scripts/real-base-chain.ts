// Dedicated verification harness: materializes and retains a bounded adaptation of the
// existing lifecycle harness; does not modify product or sealed historical evidence.
import { readFile,writeFile,mkdir,cp,readdir } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { resolve,join } from 'node:path';
import assert from 'node:assert/strict';
const repo=resolve(import.meta.dirname,'..');
const original=join(repo,'test-evidence/real-installed-inventory-20260913T164629Z');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const root=join(repo,'test-evidence/real-base-chain-'+stamp);
await mkdir(root,{recursive:true,mode:0o700});
const save=async(n:string,v:unknown)=>writeFile(join(root,n),JSON.stringify(v,null,2)+'\n');
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
let text=await readFile(join(repo,'scripts/selected-image-lifecycle.ts'),'utf8');
function replace(a:string,b:string){assert.equal(text.split(a).length,2,`Adaptation anchor not unique: ${a.slice(0,100)}`);text=text.replace(a,b);}
replace("const project=resolve(import.meta.dirname,'..');",`const project=${JSON.stringify(repo)};`);
replace("const root=join(project,'test-evidence','selected-image-lifecycle-'+new Date().toISOString().replace(/[:.]/g,'-'));",`const root=${JSON.stringify(join(root,'lifecycle'))};`);
replace("assert(url.startsWith('http://127.0.0.1:6240/'));","assert(url.startsWith(process.env.REAL_BASE_CANDIDATE_URL+'/'));");
replace("baseUrl:'http://127.0.0.1:6240'","baseUrl:process.env.REAL_BASE_CANDIDATE_URL!");
const start=text.indexOf(" const selectedPath=");const end=text.indexOf(" await save('source-hashes.json'",start);assert(start>0&&end>start);
text=text.slice(0,start)+` const response=await relayCall(manager,{action:'search',name:'Firefox',os:'linux'});
 const resultBytes=response.text;
 const bytes=Buffer.from(resultBytes);await writeFile(join(root,'original-search-result.json'),bytes,{flag:'wx'});
 const search=response.details??JSON.parse(resultBytes);
 const installation=search.applications.find((x:any)=>x.name==='Firefox')?.installations.find((x:any)=>x.os==='linux');
 assert(installation); const selectedImage=installation.image;assert.equal(selectedImage,'ubuntu2404');
 await save('selection.json',{image:selectedImage,installation,sha256:sha(bytes),source:'this attempt actual candidate public search result',composition:'candidate discovery / production lifecycle'});
`+text.slice(end);
replace("task:'selected-image-lifecycle',image:'ubuntu2404'","task:'real-base-chain',image:selectedImage");
const inventory=`
 // First clone observation, before discovery/GDM/support. Original verified input bytes only.
 const originals=${JSON.stringify(original)};
 const sealed=JSON.parse(await readFile(join(originals,'sha256.json'),'utf8'));
 for(const p of ['collect.py','aliases.json','ubuntu2404/raw-inventory.json'])assert.equal(sha(await readFile(join(originals,p))),sealed[p]);
 const observationRoot=lease.guestRoot+'/original-observation';
 await guest(['/bin/mkdir','-p','-m','700',observationRoot]);
 for(const name of ['collect.py','aliases.json'])await audit('original-input-push',{name},()=>vm.push(lease.vm,{local_path:join(originals,name),remote_path:observationRoot+'/'+name}));
 const checkCode='import hashlib,json; from pathlib import Path; p=Path('+JSON.stringify(observationRoot)+'); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ["collect.py","aliases.json"]}))';
 const inputHashes=JSON.parse((await guest(['python3','-c',checkCode])).trim());
 assert.equal(inputHashes['collect.py'],sealed['collect.py']);assert.equal(inputHashes['aliases.json'],sealed['aliases.json']);await save('guest-original-input-hashes.json',inputHashes);
 const collectorCommand=['/bin/bash','-lic','python3 '+observationRoot+'/collect.py --aliases '+observationRoot+'/aliases.json > '+observationRoot+'/inventory.json'];
 await save('immediate-collector-command.json',{argv:collectorCommand,ordering:'before GDM/support changes'});
 await guest(collectorCommand);
 const digestOutput=(await guest(['python3','-c','import hashlib; print(hashlib.sha256(open('+JSON.stringify(observationRoot+'/inventory.json')+',"rb").read()).hexdigest())'])).trim();
 const immediatePath=join(root,'immediate-inventory.json');
 await audit('immediate-inventory-pull',{remote:observationRoot+'/inventory.json'},()=>vm.pull(lease.vm,{remote_path:observationRoot+'/inventory.json',local_path:immediatePath}));
 const immediate=await readFile(immediatePath);assert.equal(sha(immediate),digestOutput);
 const canonical=(inv:any)=>({schemaVersion:inv.schemaVersion,os:inv.os,architecture:inv.architecture,sources:[...inv.sources].sort((a,b)=>a.id.localeCompare(b.id)),applications:inv.applications.map((a:any)=>({...a,aliases:[...a.aliases].sort()})).sort((a:any,b:any)=>a.id.localeCompare(b.id))});
 const historical=canonical(JSON.parse(await readFile(join(originals,'ubuntu2404/raw-inventory.json'),'utf8'))), observed=canonical(JSON.parse(immediate.toString()));
 const equality=JSON.stringify(historical)===JSON.stringify(observed);
 await save('inventory-equality.json',{equal:equality,formula:'sort applications by id and aliases, sources by id; compare every installation/source/platform field; exclude only collectedAt',historicalSha256:sha(JSON.stringify(historical)),immediateSha256:sha(JSON.stringify(observed)),notAttestation:true,notBootUpdatePrevention:true});
 // Read-only update activity, retain exact command exits within successful observer.
 const updateScript='import subprocess,json; commands=[["systemctl","list-timers","--all","--no-pager"],["systemctl","is-active","apt-daily.service","apt-daily-upgrade.service","unattended-upgrades.service","snapd.service"],["ps","-eo","pid,lstart,args"],["journalctl","-b","--no-pager","-u","apt-daily.service","-u","apt-daily-upgrade.service","-u","unattended-upgrades.service","-u","snapd.service","-n","150"]]; out=[]\\nfor cmd in commands:\\n r=subprocess.run(cmd,capture_output=True,text=True,timeout=15); out.append(dict(argv=cmd,rc=r.returncode,stdout=r.stdout,stderr=r.stderr))\\nprint(json.dumps(out))';
 const updateOutput=await guest(['python3','-c',updateScript]);await save('update-activity.json',JSON.parse(updateOutput));
 if(!equality){await save('inventory-difference.json',{historical,observed});throw Error('Immediate installation facts mismatch; stop before support/GDM; release, no equivalence claim');}
`;
replace(" // Default remains installed-only; retained support requires explicit verified opt-in.",inventory+"\n // Default remains installed-only; retained support requires explicit verified opt-in.");
replace("const expected={test:'selected-image-lifecycle',image:'ubuntu2404',selectionSha256:sha(bytes),nonUI:true};","const expected={test:'real-base-chain',image:selectedImage,selectionSha256:sha(bytes),nonUI:true};");
// Imports in generated source resolve from evidence instead of scripts.
text=text.replaceAll("from './","from '../../scripts/").replaceAll("from '../src/","from '../../src/");
const generated=join(root,'generated-lifecycle.ts');await writeFile(generated,text);
await save('adaptation.json',{original:'scripts/selected-image-lifecycle.ts',originalSha256:sha(await readFile(join(repo,'scripts/selected-image-lifecycle.ts'))),generatedSha256:sha(text),inventoryComparisonBeforeSupport:text.indexOf('inventory-equality.json')<text.indexOf('setupSelectedCloneX11(node,guest,save)')});
await cp(original,join(root,'original'),{recursive:true});
await mkdir(join(root,'sources'));
for(const p of ['scripts/real-base-chain.ts','scripts/real-base-candidate.py','scripts/real-base-candidate.test.py','scripts/selected-image-lifecycle.ts','scripts/selected-image-support.ts','scripts/selected-image-x11.ts','scripts/live-smoke-x11.ts','scripts/live-smoke-display.cjs','src/surface.ts','src/manager.ts','src/machine-service.ts','src/package.ts','src/transport.ts','src/search.ts','src/schema.ts','../pilot-images/host/inventory.py','../pilot-images/host/maintenance-lock.py','../vm-service/bin/vm-service','../vm-service/bin/application_catalog.py']){
 const destination=join(root,'sources',p.replaceAll('../','sibling/'));await mkdir(resolve(destination,'..'),{recursive:true});await cp(join(repo,p),destination);
}
await save('command.json',{argv:process.argv,scope:'one fresh service-owned clone, nonUI no video; no production publication/deploy/restart; human review pending'});
if(!process.argv.includes('--run')){console.log(JSON.stringify({testedAdaptation:true,root}));process.exit(0);}
const child=spawn('python3',['-u',join(repo,'../pilot-images/host/maintenance-lock.py'),'acquire','ubuntu2404','python3','-u',join(repo,'scripts/real-base-candidate.py'),repo,original,root],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
let stderr='';child.stderr.on('data',b=>stderr+=b);let exited=false;
const childExit=new Promise<any>(res=>child.once('exit',(code,signal)=>{exited=true;res({code,signal});}));
const readyPromise=new Promise<any>((res,rej)=>{const timer=setTimeout(()=>rej(Error('candidate startup timeout')),30000);createInterface({input:child.stdout}).once('line',s=>{clearTimeout(timer);try{res(JSON.parse(s));}catch(e){rej(e);}});child.once('exit',code=>{clearTimeout(timer);rej(Error('candidate startup exit '+code));});});
let ready:any,failed:any,lifecycleExit:any;
try{
 ready=await readyPromise;assert(ready.ready);await save('candidate-ready.json',ready);
 const supportArg=process.argv.indexOf('--support-driver');assert(supportArg>0);const support=process.argv[supportArg+1];assert(support);
 const run=spawn(join(repo,'node_modules/.bin/tsx'),[generated,'--run','--support-driver',support],{cwd:repo,env:{...process.env,REAL_BASE_CANDIDATE_URL:ready.url},stdio:['ignore','pipe','pipe']});
 let stdout='',errors='';run.stdout.on('data',b=>stdout+=b);run.stderr.on('data',b=>errors+=b);
 lifecycleExit=await new Promise<any>(res=>run.once('exit',(code,signal)=>res({code,signal,stdout,stderr:errors})));await save('lifecycle-command-exit.json',lifecycleExit);
 assert.equal(lifecycleExit.code,0,'lifecycle nonzero (not replayed)');
 const requests=JSON.parse(await readFile(join(root,'proxy-requests.json'),'utf8'));
 const acquires=requests.filter((r:any)=>r.path==='/acquire');assert.equal(acquires.length,1);
 const selected=JSON.parse(await readFile(join(root,'lifecycle/selection.json'),'utf8'));
 assert.equal(JSON.parse(acquires[0].requestBytes).image,selected.image);
 await save('selection-acquire-equality.json',{equal:true,selectedImage:selected.image,originalSearchSha256:selected.sha256,acquisitionRequestBytes:acquires[0].requestBytes});
}catch(e){failed=String(e);await save('failure.json',{error:failed});}
finally{
 if(!exited)child.stdin.end('stop\n');const exit=await childExit;await save('candidate-command-exit.json',{...exit,stderr});if(exit.code!==0)failed??='candidate nonzero';
 if(ready){const refused=await new Promise<boolean>(res=>{const s=createConnection({host:'127.0.0.1',port:Number(new URL(ready.url).port)});s.setTimeout(2000);s.once('error',(e:any)=>{s.destroy();res(e.code==='ECONNREFUSED');});s.once('connect',()=>{s.destroy();res(false);});s.once('timeout',()=>{s.destroy();res(false);});});await save('port-cleanup.json',{connectionRefused:refused,url:ready.url});if(!refused)failed??='candidate port remains';}
 await save('summary.json',{outcome:failed?'blocked-or-failed':'passed',error:failed,lifecycleExit:lifecycleExit?.code,nonUI:true,video:'not recorded / not applicable',humanReview:'pending',root});
 const files:Record<string,string>={};async function walk(p:string){for(const e of await readdir(join(root,p),{withFileTypes:true})){const n=join(p,e.name);if(e.isDirectory())await walk(n);else if(e.isFile())files[n]=sha(await readFile(join(root,n)));}}await walk('');await save('manifest.json',{schemaVersion:1,formula:'SHA256 original file bytes; manifest excludes itself',files});
 console.log(JSON.stringify({root,outcome:failed?'blocked-or-failed':'passed',error:failed}));if(failed)process.exitCode=1;
}
