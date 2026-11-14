import type { FramedRequest, FramedResponse, SessionTransport } from '@wezzard/relay-driver-host-sdk';
import { join } from 'node:path';
import { Transfer, assertHostPath } from './transfer.js';
import { jsonFile, hash } from './util.js';

/** Receiver stdout can contain escaped output larger than machine-service's 64000
 * character tail. Discard it, retaining only a small dispatch acknowledgement;
 * the receiver's durable file is the authoritative response. */
const INVOKE = `const {spawnSync}=require('child_process');const [receiver,request]=process.argv.slice(1);const result=spawnSync(process.execPath,[receiver,request],{stdio:['ignore','ignore','inherit']});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);console.log('{"receiverExited":true}');`;

/**
 * Stops a cancelled run in the guest (DC-86). The relay agent's cancel kills
 * only the exec's process group, and the receiver runs the script in a group of
 * its own, so the script and the receiver's lock would outlive it. This kills
 * whatever still runs the request (the dispatcher and the receiver, found by
 * the request path among their arguments), then the process groups the
 * receiver recorded for this execution, and waits until both are gone. It
 * writes no receipt and leaves the started marker, so nothing is replayed;
 * the next receiver reclaims the lock of an owner proved gone.
 */
export const STOP = `const fs=require('fs'),p=require('path'),cp=require('child_process');const [root,id]=process.argv.slice(1);
const request=p.join(root,'requests',id+'.json'),owner=p.join(root,'.receiver-lock','owner.json');
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const alive=(pid,group)=>{try{process.kill(group?-pid:pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const kill=(pid,group)=>{try{process.kill(group?-pid:pid,'SIGKILL');}catch{}};
const settle=left=>{const until=Date.now()+5000;while(left().length&&Date.now()<until)pause(25);return left();};
const skip=new Set([process.pid,process.ppid]);
const runners=cp.execFileSync('ps',['-axww','-o','pid=,command='],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\\n').map(l=>/^\\s*(\\d+)\\s+(.*)$/.exec(l)).filter(m=>m&&!skip.has(Number(m[1]))&&m[2].split(' ').includes(request)).map(m=>Number(m[1]));
for(const pid of runners)kill(pid,false);
const runnersLeft=settle(()=>runners.filter(pid=>alive(pid,false)));
let record;try{record=JSON.parse(fs.readFileSync(owner,'utf8'));}catch{}
const mine=!!record&&record.executionId===id;
const groups=mine&&Array.isArray(record.operationPids)?record.operationPids.filter(g=>Number.isInteger(g)&&g>1):[];
for(const g of groups)if(alive(g,true))kill(g,true);
const groupsLeft=settle(()=>groups.filter(g=>alive(g,true)));
const pendingSpawn=mine&&record.pendingSpawn===true;
console.log(JSON.stringify({stopped:!runnersLeft.length&&!groupsLeft.length&&!pendingSpawn,runners:runners.length,groups:groups.length,runnersLeft,groupsLeft,pendingSpawn}));`;

function validateResponse(data: any, executionId: string): asserts data is FramedResponse {
  if (!data || typeof data !== 'object' || data.executionId !== executionId || !['completed', 'refused', 'uncertain'].includes(data.outcome?.kind)) throw new Error('Malformed receiver response / identity mismatch');
  if (data.outcome.kind === 'completed') {
    const exit = data.outcome.exitStatus;
    if (!exit || !(exit.code === null || Number.isSafeInteger(exit.code)) || !(exit.signal === null || typeof exit.signal === 'string')) throw new Error('Completed response lacks valid exit status');
  } else if (typeof data.outcome.diagnostic !== 'string') throw new Error('Receiver response lacks diagnostic');
}

export class VmTransport implements SessionTransport {
  because = '';
  timeoutMs = 120000;
  diagnostic = false;
  /** False when the lease's image lists no capture software: the receiver takes no snapshots (docs/guest-code-runs.md §3). */
  capture = true;
  /** The current run's cancellation: a cancelled dispatch stops waiting for the receiver and is reported as uncertain. */
  signal?: AbortSignal;
  response?: FramedResponse & { stdout?: string; stderr?: string; timeoutMs?: number; evidenceMode?: string; terminationConfirmed?: boolean };
  constructor(readonly transfer: Transfer, readonly guestRoot: string, readonly hostRoot: string, readonly cuaDriver: string) {}
  async send(request: FramedRequest): Promise<FramedResponse> {
    if (!this.because.trim()) throw new Error('Run execution intent is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(request.executionId)) throw new Error('Invalid execution identity');
    this.response = undefined;
    // The SDK names a kind and an interpreter when it frames a request; the guest builds the command from the
    // language and the verified script, so the request file has neither (DC-26).
    const { kind: _kind, argv: _argv, ...framed } = request;
    const payload = { ...framed, because: this.because, timeoutMs: this.timeoutMs, ...(this.diagnostic ? { diagnostic: true } : {}), ...(this.capture ? {} : { capture: false }) };
    const local = join(this.hostRoot, 'requests', `${request.executionId}.json`);
    const remote = join(this.guestRoot, 'requests', `${request.executionId}.json`);
    await assertHostPath(this.hostRoot, local, true);
    await jsonFile(local, payload); // reason + exact request retained before transmission
    await this.transfer.pushFile(local, remote, this.hostRoot);
    const wait = request.snapshots?.group?.afterIntervalMs ?? request.snapshots?.afterIntervalMs ?? 0;
    let response: FramedResponse;
    try {
      const result = await this.transfer.vm.exec(this.transfer.name, [
        '/usr/bin/env', `RELAY_RUNTIME_ROOT=${this.guestRoot}`, `RELAY_CUA_DRIVER=${this.cuaDriver}`,
        this.transfer.node, '-e', INVOKE, join(this.guestRoot, 'receiver.mjs'), remote,
      ], this.timeoutMs + 180000 + wait, { signal: this.signal, executionId: request.executionId });
      if (result.code !== 0) throw new Error(`Receiver exit ${result.code}: ${result.stderr.slice(0, 1000)}`);
      const guestReceipt = join(this.guestRoot, 'state', 'receiver', 'receipts', `${request.executionId}.json`);
      const originalReceipt = join(this.hostRoot, 'receiver-receipts', `${request.executionId}.json`);
      const bytes = await this.transfer.pullFrame(guestReceipt, originalReceipt, this.guestRoot, this.hostRoot);
      const data: unknown = JSON.parse(bytes.toString('utf8'));
      validateResponse(data, request.executionId);
      response = data;
    } catch (error) {
      // A cancelled run is stopped in the guest before the next operation on it (DC-86); still uncertain, never replayed.
      const stopped = this.signal?.aborted ? `; ${await this.stop(request.executionId)}` : '';
      response = { executionId: request.executionId, outcome: { kind: 'uncertain', diagnostic: `${String(error)}${stopped}` } };
    }
    const receipt = join(this.hostRoot, 'receipts', `${request.executionId}.json`);
    await assertHostPath(this.hostRoot, receipt, true);
    await jsonFile(receipt, response);
    await assertHostPath(this.hostRoot, receipt);
    this.response = response;
    return response;
  }
  /** Stop a cancelled execution in the guest, without the aborted signal; says what it found. */
  private async stop(executionId: string): Promise<string> {
    try {
      const answer = (await this.transfer.checked([this.transfer.node, '-e', STOP, this.guestRoot, executionId], 30000)).trim().split('\n').at(-1) ?? '';
      const fact = JSON.parse(answer) as { stopped?: boolean };
      return fact.stopped === true ? `stopped in the guest: ${answer}` : `not confirmed stopped in the guest: ${answer}`;
    } catch (error) { return `stopping it in the guest failed: ${String(error)}`; }
  }
  async upload(path: string, options: { remotePath: string }) {
    const fact = await this.transfer.pushFile(path, options.remotePath);
    return { scriptId: `script-${hash(fact.remote + fact.sha256).slice(0, 24)}`, path: options.remotePath };
  }
  async finish(): Promise<never> { throw new Error('Use relay action=finish: SDK finish lacks snapshot manifest classification'); }
  async close() { /* Stateless HTTP channel, owned exclusively by the enclosure. */ }
}
