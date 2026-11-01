import { spawn } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { lookup } from 'node:dns/promises';

/**
 * A one-shot Multicast DNS query for DNS-SD instances (RFC 6762 §5.1, RFC
 * 6763), with no dependency: Node.js has no DNS-SD API. The query goes to
 * 224.0.0.251:5353 from an ephemeral port, so responders answer it by unicast
 * to that port (RFC 6762 §6.7), and the answers are read for a window
 * (docs/durable-machines.md §2, machine-service DC-85).
 */

/** One instance a browse found: what its advertisement says. */
export interface Advertised {
  /** The service instance name, such as `Mac-A` in `Mac-A._machine-service._tcp.local`. */
  name: string;
  /** The instance ID its TXT record states, else its name. */
  instance: string;
  /** The permanent identity its TXT record states, when supported. */
  machine_id?: string;
  /** The host its SRV record names, such as `Mac-A.local`. */
  host: string;
  /** An IPv4 address of that host, when one was answered. */
  address?: string;
  port: number;
  txt: Record<string, string>;
}

interface Record_ { name: string; type: number; data: Buffer; message: Buffer; offset: number }
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;
const GROUP = '224.0.0.251', PORT = 5353;

/** A DNS name as labels, lowercased for comparison (DNS names are case-insensitive). */
const key = (name: string) => name.replace(/\.$/, '').toLowerCase();

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').map(label => Buffer.from(label, 'utf8'));
  if (parts.some(part => part.length === 0 || part.length > 63)) throw new Error(`Invalid DNS name ${name}`);
  return Buffer.concat([...parts.flatMap(part => [Buffer.from([part.length]), part]), Buffer.from([0])]);
}

/** A query message with the given questions, class IN. */
export function encodeQuery(questions: Array<{ name: string; type: number }>): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([header, ...questions.flatMap(q => { const tail = Buffer.alloc(4); tail.writeUInt16BE(q.type, 0); tail.writeUInt16BE(1, 2); return [encodeName(q.name), tail]; })]);
}

/** Read a possibly compressed name at `offset`; returns the name and the offset after it in place. */
function readName(message: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let at = offset, end = -1, jumps = 0;
  for (;;) {
    if (at >= message.length) throw new Error('DNS name runs past the message');
    const length = message[at]!;
    if (length === 0) { at += 1; break; }
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= message.length || ++jumps > 32) throw new Error('Invalid DNS name pointer');
      if (end < 0) end = at + 2;
      at = ((length & 0x3f) << 8) | message[at + 1]!;
      continue;
    }
    if (at + 1 + length > message.length) throw new Error('DNS label runs past the message');
    labels.push(message.toString('utf8', at + 1, at + 1 + length));
    at += 1 + length;
  }
  return [labels.join('.'), end < 0 ? at : end];
}

/** Every resource record of a response, in all three sections. A malformed message yields what parsed before it. */
export function parseRecords(message: Buffer): Record_[] {
  const records: Record_[] = [];
  try {
    if (message.length < 12 || !(message[2]! & 0x80)) return records; // not a response
    const questions = message.readUInt16BE(4), total = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
    let at = 12;
    for (let i = 0; i < questions; i++) at = readName(message, at)[1] + 4;
    for (let i = 0; i < total; i++) {
      const [name, next] = readName(message, at);
      const type = message.readUInt16BE(next), length = message.readUInt16BE(next + 8), start = next + 10;
      if (start + length > message.length) break;
      records.push({ name, type, data: message.subarray(start, start + length), message, offset: start });
      at = start + length;
    }
  } catch { /* keep what parsed */ }
  return records;
}

function txtOf(data: Buffer): Record<string, string> {
  const txt: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const length = data[at]!;
    if (at + 1 + length > data.length) break;
    const pair = data.toString('utf8', at + 1, at + 1 + length);
    at += 1 + length;
    if (!pair) continue;
    const split = pair.indexOf('=');
    txt[(split < 0 ? pair : pair.slice(0, split)).toLowerCase()] = split < 0 ? '' : pair.slice(split + 1);
  }
  return txt;
}

/** What a set of records says about the instances of `service`. Instances without an SRV record are left out. */
export function assemble(service: string, records: Record_[]): Advertised[] {
  const by = (type: number, name: string) => records.filter(r => r.type === type && key(r.name) === key(name));
  const names = new Set(by(TYPE.PTR, service).map(r => readName(r.message, r.offset)[0]));
  const found: Advertised[] = [];
  for (const full of names) {
    const srv = by(TYPE.SRV, full)[0];
    if (!srv || srv.data.length < 7) continue;
    const port = srv.data.readUInt16BE(4), host = readName(srv.message, srv.offset + 6)[0];
    const txt = Object.assign({}, ...by(TYPE.TXT, full).map(r => txtOf(r.data)));
    const a = by(TYPE.A, host).find(r => r.data.length === 4);
    const name = full.slice(0, full.length - service.length - 1);
    found.push({ name, instance: txt.instance || name, ...(txt.machine_id ? { machine_id: txt.machine_id } : {}), host: host.replace(/\.$/, ''), ...(a ? { address: [...a.data].join('.') } : {}), port, txt });
  }
  return found.sort((x, y) => x.name.localeCompare(y.name));
}

/** Sends one query and hands every response to `receive` until closed. */
export interface Transport { send(query: Buffer): void; close(): void }
export type OpenTransport = (receive: (message: Buffer) => void) => Promise<Transport>;

/** A UDP socket on an ephemeral port that sends to the Multicast DNS group. */
export const udpTransport: OpenTransport = receive => new Promise((resolve, reject) => {
  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', message => receive(message));
  socket.once('error', reject);
  socket.bind(0, () => {
    socket.setMulticastTTL(255);
    resolve({ send: query => socket.send(query, PORT, GROUP), close: () => socket.close() });
  });
});

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

/**
 * Browse `service` (such as `_machine-service._tcp.local`) for `windowMs`,
 * then ask once more, for up to `followUpMs`, for the SRV, TXT and A records
 * that the first answers left out.
 */
export async function browse(service: string, windowMs = 2000, followUpMs = 1000, open: OpenTransport = udpTransport): Promise<Advertised[]> {
  const records: Record_[] = [];
  const transport = await open(message => records.push(...parseRecords(message)));
  try {
    // Ask the question twice within the window, as continuous querying does
    // (RFC 6762 §5.2), so one lost query or answer does not hide an instance.
    const question = encodeQuery([{ name: service, type: TYPE.PTR }]);
    transport.send(question);
    await wait(windowMs / 2);
    transport.send(question);
    await wait(windowMs / 2);
    const missing = [...new Set(records.filter(r => r.type === TYPE.PTR && key(r.name) === key(service)).map(r => readName(r.message, r.offset)[0]))]
      .filter(full => !assemble(service, records).some(found => key(`${found.name}.${service}`) === key(full) && found.address));
    if (missing.length) {
      const hosts = records.filter(r => r.type === TYPE.SRV).map(r => readName(r.message, r.offset + 6)[0]);
      transport.send(encodeQuery([...missing.flatMap(name => [{ name, type: TYPE.SRV }, { name, type: TYPE.TXT }]), ...hosts.map(name => ({ name, type: TYPE.A }))]));
      await wait(followUpMs);
    }
    return assemble(service, records);
  } finally { transport.close(); }
}

/** Undo DNS-SD's presentation escapes: `\DDD` (decimal byte) and `\c`. */
const unescape = (text: string) => Buffer.from(text.replace(/\\(\d{3})|\\(.)/g, (_, code: string | undefined, char: string | undefined) => code ? String.fromCharCode(Number(code)) : char!), 'latin1').toString('utf8');

/**
 * Parse `dns-sd -Z <type> local.` output: PTR, SRV and TXT lines in zone-file
 * form. An instance is kept once its SRV has arrived; its address is left for
 * the system resolver.
 */
export function parseZone(zone: string): Advertised[] {
  const lines = zone.split('\n').map(line => line.replace(/\s;.*$/, '').trim()).filter(line => line && !line.startsWith(';'));
  const field = (line: string) => line.match(/^(\S+)\s+(PTR|SRV|TXT)\s+(.*)$/);
  const order: string[] = [], srv = new Map<string, { port: number; host: string }>(), txt = new Map<string, Record<string, string>>();
  for (const line of lines) {
    const match = field(line); if (!match) continue;
    const [, owner, type, rest] = match as unknown as [string, string, string, string];
    if (type === 'PTR') { const full = rest.trim(); if (!order.includes(full)) order.push(full); }
    else if (type === 'SRV') { const [, , port, host] = rest.trim().split(/\s+/); if (port && host) srv.set(owner, { port: Number(port), host: host.replace(/\.$/, '') }); }
    else txt.set(owner, Object.fromEntries([...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, pair]) => unescape(pair!)).filter(pair => pair).map(pair => { const at = pair.indexOf('='); return at < 0 ? [pair.toLowerCase(), ''] : [pair.slice(0, at).toLowerCase(), pair.slice(at + 1)]; })));
  }
  return order.flatMap(full => {
    const target = srv.get(full); if (!target) return [];
    const name = unescape(full.split(/(?<!\\)\./)[0]!);
    const record = txt.get(full) ?? {};
    return [{ name, instance: record.instance || name, ...(record.machine_id ? { machine_id: record.machine_id } : {}), host: target.host, port: target.port, txt: record }];
  });
}

/** How the system browser runs `dns-sd` and resolves a host; seams for tests. */
export interface SystemTools { run(argv: string[], ms: number): Promise<string>; lookup(host: string): Promise<string | undefined> }
const systemTools: SystemTools = {
  run: (argv, ms) => new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), ms);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(out); });
  }),
  lookup: host => lookup(host, { family: 4 }).then(found => found.address, () => undefined),
};

/** Where macOS's DNS-SD command lives; the system browser is used when it exists. */
export const DNS_SD = '/usr/bin/dns-sd';

/**
 * Browse through the system's DNS-SD service (mDNSResponder), as machctl does,
 * by reading `dns-sd -Z` for `windowMs`: the service keeps a live, cached view
 * of the network, so one lost multicast answer does not hide an instance.
 */
export async function systemBrowse(service: string, windowMs = 1500, tools: SystemTools = systemTools): Promise<Advertised[]> {
  const type = service.replace(/\.local\.?$/, '');
  const found = parseZone(await tools.run([DNS_SD, '-Z', type, 'local.'], windowMs));
  return Promise.all(found.map(async advert => { const address = await tools.lookup(advert.host); return address ? { ...advert, address } : advert; }));
}
