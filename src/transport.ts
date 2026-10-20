import type { FramedRequest, FramedResponse, SessionTransport } from '@wezzard/relay-driver-host-sdk';
import { join } from 'node:path';
import { Transfer, assertHostPath } from './transfer.js';
import { jsonFile, hash } from './util.js';

/** Receiver stdout can contain escaped output larger than machine-service's 64000
 * character tail. Discard it, retaining only a small dispatch acknowledgement;
 * the receiver's durable file is the authoritative response. */
const INVOKE = `const {spawnSync}=require('child_process');const [receiver,request]=process.argv.slice(1);const result=spawnSync(process.execPath,[receiver,request],{stdio:['ignore','ignore','inherit']});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);console.log('{"receiverExited":true}');`;

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
      ], this.timeoutMs + 180000 + wait, { signal: this.signal });
      if (result.code !== 0) throw new Error(`Receiver exit ${result.code}: ${result.stderr.slice(0, 1000)}`);
      const guestReceipt = join(this.guestRoot, 'state', 'receiver', 'receipts', `${request.executionId}.json`);
      const originalReceipt = join(this.hostRoot, 'receiver-receipts', `${request.executionId}.json`);
      const bytes = await this.transfer.pullFrame(guestReceipt, originalReceipt, this.guestRoot, this.hostRoot);
      const data: unknown = JSON.parse(bytes.toString('utf8'));
      validateResponse(data, request.executionId);
      response = data;
    } catch (error) {
      response = { executionId: request.executionId, outcome: { kind: 'uncertain', diagnostic: String(error) } };
    }
    const receipt = join(this.hostRoot, 'receipts', `${request.executionId}.json`);
    await assertHostPath(this.hostRoot, receipt, true);
    await jsonFile(receipt, response);
    await assertHostPath(this.hostRoot, receipt);
    this.response = response;
    return response;
  }
  async upload(path: string, options: { remotePath: string }) {
    const fact = await this.transfer.pushFile(path, options.remotePath);
    return { scriptId: `script-${hash(fact.remote + fact.sha256).slice(0, 24)}`, path: options.remotePath };
  }
  async finish(): Promise<never> { throw new Error('Use relay action=finish: SDK finish lacks snapshot manifest classification'); }
  async close() { /* Stateless HTTP channel, owned exclusively by the enclosure. */ }
}
