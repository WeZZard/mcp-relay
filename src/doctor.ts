import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { command, hash } from './util.js';
import { MachineService, expectMachineService } from './machine-service.js';
import { Registry, validateRegistryText } from './registry.js';
import { pythonExecutable, relayStateRoot } from './config.js';
import { selectedEnvironment, environmentVariables, matchesEnvironment } from './environment.js';

export async function installationReport(options: { assetsDir?: string; run?: typeof command; vm?: MachineService; registry?: Registry } = {}) {
 const checks: Array<{ name:string; ok:boolean; detail:string }> = [];
 const check=async(name:string,fn:()=>Promise<string>)=>{try{checks.push({name,ok:true,detail:await fn()});}catch(e){checks.push({name,ok:false,detail:String(e)});}};
 const environment=selectedEnvironment();
 const run=options.run??command;
 const assets=options.assetsDir??fileURLToPath(new URL('../dist/',import.meta.url));
 await check('node',async()=>{if(Number(process.versions.node.split('.')[0])<22)throw Error('Install Node.js 22 or newer.');return process.versions.node;});
 await check('host',async()=>{if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The supported local Tart/machine-service backend requires an Apple-silicon Mac. Ubuntu is a guest, not a substitute host.');return `${process.platform}/${process.arch}`;});
 await check('python',async()=>{const r=await run([pythonExecutable(),'-c','import fcntl, sys; print(sys.version.split()[0])'],{timeoutMs:5000});if(r.code!==0)throw Error('Install Python 3 with fcntl, or set MCP_RELAY_PYTHON to its executable. '+r.stderr);return r.stdout.trim();});
 await check('runtime-bundles',async()=>{
  const integrity=JSON.parse(await readFile(join(assets,'integrity.json'),'utf8'));
  for(const name of ['server.mjs','receiver.mjs','doctor.mjs']){
   const b=await readFile(join(assets,name));if(hash(b)!==integrity[name])throw Error(`Invalid/missing shipped ${name}; reinstall the package.`);
  }
  return 'Host extension, guest receiver and doctor hashes verified';
 });
 await check('registry',async()=>{const registry=options.registry??new Registry(environment?{managedRoot:environment.profile.relayStateDir}:{});try{await access(registry.path);validateRegistryText(await readFile(registry.path,'utf8'));return `Existing registry: ${registry.path}`;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(process.env.MCP_RELAY_REGISTRY)throw Error('MCP_RELAY_REGISTRY must point to an existing Using VMs registry table.');return `Managed registry will be created on first acquisition: ${registry.path}`;}});
 await check('tart',async()=>{const r=await run([environment?.profile.tartPath??'tart','list','--format','json'],{timeoutMs:10000,...(environment?{env:{...process.env,...environmentVariables(environment)}}:{})});if(r.code!==0||!Array.isArray(JSON.parse(r.stdout)))throw Error('Install Tart and ensure tart list --format json works; required for independent destruction verification.');return 'Read-only local inventory available';});
 await check('machine-service',async()=>{const vm=options.vm??new MachineService({baseUrl:environment?.profile.vmServiceUrl??process.env.MCP_RELAY_URL,environment});const health=await vm.health({timeoutMs:5000});if(!health.ok)throw Error('Service health check failed');expectMachineService(health,vm.baseUrl);if(environment&&!matchesEnvironment(health.environment,environment))throw Error('machine-service environment identity mismatch');const images=await vm.images({timeoutMs:5000});await vm.list({timeoutMs:5000});const available=Object.entries(images.images).filter(([,v])=>v.base_available).map(([k])=>k);if(!available.length)throw Error('machine-service is running but has no available golden images. Provision a supported image in the backend.');return `HTTP API reachable; available images: ${available.join(', ')}. This inventory does not prove guest readiness. Use relay probe scope=guest for executable checks; capture and browser behavior require separate checks. Staging alone is not readiness.`;});
 return {formatVersion:1,ready:checks.every(c=>c.ok),environment:environment?.identity,stateDirectory:environment?.profile.relayStateDir??relayStateRoot(),checks,note:'Read-only host/API prerequisite check. No VM acquired, input sent, screenshot captured or permissions changed. Claude Code (or another MCP client) must be installed separately.'};
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url){
 try{const r=await installationReport();console.log(JSON.stringify(r,null,2));process.exitCode=r.ready?0:1;}
 catch(e){console.log(JSON.stringify({ready:false,error:String(e),hint:'Check MCP_RELAY_* configuration and installation paths.'},null,2));process.exitCode=1;}
}
