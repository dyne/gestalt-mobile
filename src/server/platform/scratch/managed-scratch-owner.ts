/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  mobileScratchOwnerId,
  privateDirectory,
  readMarker,
  scratchMarkerName,
} from './scratch-filesystem.js';

export const scratchUuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ownerPattern = `(?:mobile-[0-9a-f]{64}|(?:cli|service)-${scratchUuidPattern})`;
const ownerName = new RegExp(`^${ownerPattern}$`);
const removalName = new RegExp(`^\\.cleanup-(${ownerPattern})-${scratchUuidPattern}$`);
const isUuid = new RegExp(`^${scratchUuidPattern}$`);
const leaseName = new RegExp(`^(${scratchUuidPattern})\\.json$`);
const stableId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const validTime = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export type ManagedScratchOwner = {
  schemaVersion: number;
  ownerKind: string;
  ownerId: string;
  workspacePath: string;
  sessionId: string;
  createdAt: string;
  authority: { kind: string; sessionId?: string; leaseId?: string };
  providerThreads: { provider: string; threadId: string }[];
};

export function managedScratchOwnerId(name: string): string | undefined {
  return ownerName.test(name) ? name : removalName.exec(name)?.[1];
}

export async function canonicalScratchWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  const canonical = await realpath(path);
  const info = await lstat(path);
  if (
    canonical !== resolve(path) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  return canonical;
}

function rejectOwner(): never {
  throw new Error('SCRATCH_CLEANUP_unrecognized');
}

/** Metadata recognition alone never authorizes deletion: leases, roster and fences still apply. */
export async function readManagedScratchOwner(
  directory: string,
  workspacePath: string,
  ownerId: string,
): Promise<ManagedScratchOwner> {
  let marker: ManagedScratchOwner | null;
  try {
    marker = (await readMarker(join(directory, scratchMarkerName))) as ManagedScratchOwner | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') rejectOwner();
    throw error;
  }
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    marker.ownerId !== ownerId ||
    marker.workspacePath !== workspacePath ||
    !validTime(marker.createdAt) ||
    !Array.isArray(marker.providerThreads) ||
    marker.providerThreads.some(
      (thread) =>
        !thread ||
        !['codex', 'kimi'].includes(thread.provider) ||
        typeof thread.threadId !== 'string' ||
        !stableId.test(thread.threadId),
    )
  )
    rejectOwner();
  if (marker.ownerKind === 'mobile-session') {
    if (
      typeof marker.sessionId !== 'string' ||
      !stableId.test(marker.sessionId) ||
      mobileScratchOwnerId(marker.sessionId) !== ownerId ||
      marker.authority?.kind !== 'mobile-roster' ||
      marker.authority.sessionId !== marker.sessionId
    )
      rejectOwner();
  } else if (marker.ownerKind === 'cli-session' || marker.ownerKind === 'workspace-service') {
    const prefix = marker.ownerKind === 'cli-session' ? 'cli-' : 'service-';
    if (
      !ownerId.startsWith(prefix) ||
      marker.sessionId !== ownerId ||
      marker.authority?.kind !== 'lease' ||
      !isUuid.test(marker.authority.leaseId ?? '')
    )
      rejectOwner();
  } else rejectOwner();
  return marker;
}

/** Attribution is read-only; it does not prove release or supply deletion authority. */
export async function readManagedScratchAttribution(directory: string, allowRetired = false) {
  const container = dirname(directory);
  const temporary = dirname(container);
  const name = basename(directory);
  const ownerId = managedScratchOwnerId(name);
  if (
    basename(container) !== 'sessions' ||
    basename(temporary) !== 'tmp' ||
    !ownerId ||
    (!allowRetired && ownerId !== name)
  )
    rejectOwner();
  const workspacePath = dirname(temporary);
  await canonicalScratchWorkspace(workspacePath);
  const info = await lstat(temporary);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(temporary)) !== temporary ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  await privateDirectory(container, false);
  await privateDirectory(directory, false);
  const marker = await readManagedScratchOwner(directory, workspacePath, ownerId);
  return { directory, workspacePath, ownerId, marker };
}

export type ManagedScratchLease = Readonly<{
  schemaVersion: number;
  ownerId: string;
  workspacePath: string;
  leaseId: string;
  state: 'active' | 'released';
  processIdentity: string;
  createdAt: string;
  updatedAt: string;
  consumers: readonly string[];
}>;

function rejectLease(): never {
  throw new Error('SESSION_SCRATCH_LEASE_INVALID');
}

export async function readManagedScratchLeases(
  directory: string,
  marker: ManagedScratchOwner,
): Promise<ManagedScratchLease[]> {
  if (!(await readdir(directory)).includes('leases')) {
    if (marker.ownerKind !== 'mobile-session') rejectLease();
    return [];
  }
  const leases = join(directory, 'leases');
  await privateDirectory(leases, false);
  const records: ManagedScratchLease[] = [];
  for (const name of await readdir(leases)) {
    const leaseId = leaseName.exec(name)?.[1];
    if (!leaseId) rejectLease();
    const value = (await readMarker(join(leases, name))) as ManagedScratchLease | null;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.ownerId !== marker.ownerId ||
      value.workspacePath !== marker.workspacePath ||
      value.leaseId !== leaseId ||
      typeof value.processIdentity !== 'string' ||
      !isUuid.test(value.processIdentity) ||
      !validTime(value.createdAt) ||
      !validTime(value.updatedAt) ||
      !['active', 'released'].includes(value.state) ||
      !Array.isArray(value.consumers) ||
      !value.consumers.every(
        (consumer) => typeof consumer === 'string' && stableId.test(consumer),
      ) ||
      (value.state === 'released' && value.consumers.length !== 0)
    )
      rejectLease();
    records.push(value);
  }
  if (
    marker.ownerKind !== 'mobile-session' &&
    !records.some((lease) => lease.leaseId === marker.authority.leaseId)
  )
    rejectLease();
  return records;
}

/** Discovery excludes only attributed scratch; unknown/plain directories remain discoverable. */
export async function isManagedScratchOwnerDirectory(directory: string): Promise<boolean> {
  try {
    await readManagedScratchAttribution(directory, true);
    return true;
  } catch {
    return false;
  }
}
