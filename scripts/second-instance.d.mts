/** Types for second-instance.mjs, which the live scripts share as plain JavaScript. */
import type { Transport, VmBackend } from '../src/machine-service.js';

/** What a live tool reaches: the instance's ID, origin, Tart store and clone prefix. */
export interface SecondInstance {
  id: string;
  root: string;
  origin: string;
  port: number;
  tartHome: string;
  /** The store is the operator's own (~/.tart), which the instance only reads bases from (DC-246). */
  operatorStore: boolean;
  /** `si-<id>-`: the only VMs a live tool touches. */
  vmPrefix: string;
  /** The daemon's whole environment, as the manifest records it. */
  env: Readonly<Record<string, string>>;
}

export const MANIFEST: 'second-instance.json';
export const INSTALLED_PORTS: readonly number[];
export function vmPrefix(id: string): string;
export function canonicalPath(path: string): string;
export function overlaps(a: string, b: string): boolean;
export function secondInstance(manifest: unknown, root: string, home: string): SecondInstance;
export function readSecondInstance(root: string, home: string): Promise<SecondInstance>;
export function confirmMark(instance: SecondInstance, health: unknown): void;
export function connectSecondInstance(root: string, home: string, fetcher?: typeof fetch): Promise<{ instance: SecondInstance; health: unknown }>;
export function ownedVm(instance: SecondInstance, vm: unknown): string;
export function confirmOwnedMachines(instance: SecondInstance, list: unknown): void;
export function admitRequest(instance: SecondInstance, method: string, url: string): void;
export function instanceTransport(instance: SecondInstance, base?: Transport): Transport;
export function ownedBackend<T extends VmBackend>(instance: SecondInstance, backend: T): T;
export function ownedFolder(instance: SecondInstance, variable: string): string;
export function ownRegistry(path: string, home: string): string;
export function flagValue(args: readonly string[], name: string): string | undefined;
