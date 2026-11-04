/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  canonicalScratchWorkspace,
  readManagedScratchAttribution,
  readManagedScratchLeases,
} from './managed-scratch-owner.js';
import { privateDirectory } from './scratch-filesystem.js';

export const containmentFenceName = '.containment-lock';
type Identity = Readonly<{ dev: bigint; ino: bigint; birth: bigint }>;
const same = (left: Identity, right: Identity) =>
  left.dev === right.dev && left.ino === right.ino && left.birth === right.birth;

async function directoryIdentity(path: string): Promise<Identity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('SESSION_SCRATCH_CONTAINMENT_INVALID');
  return { dev: info.dev, ino: info.ino, birth: info.birthtimeNs };
}

async function ancestorIdentity(directory: string, allowRetired: boolean) {
  let owner: Awaited<ReturnType<typeof readManagedScratchAttribution>>;
  try {
    owner = await readManagedScratchAttribution(directory, allowRetired);
    await readManagedScratchLeases(directory, owner.marker);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('SESSION_SCRATCH_') || error.message.startsWith('SCRATCH_CLEANUP_'))
    )
      throw error;
    throw new Error('SESSION_SCRATCH_CONTAINMENT_INVALID', { cause: error });
  }
  const marker = owner.marker;
  return {
    directory,
    ownerId: owner.ownerId,
    identity: await directoryIdentity(directory),
    provenance: JSON.stringify([
      marker.schemaVersion,
      marker.ownerKind,
      marker.ownerId,
      marker.workspacePath,
      marker.sessionId,
      marker.createdAt,
      marker.authority.kind,
      marker.authority.sessionId ?? null,
      marker.authority.leaseId ?? null,
    ]),
  };
}

type Ancestor = Awaited<ReturnType<typeof ancestorIdentity>>;
type Claim = {
  directory: string;
  path: string;
  identity: Identity;
  handle?: FileHandle;
  attempted: boolean;
};

async function assertClaimIdentity(claim: Claim): Promise<void> {
  if (claim.handle) {
    const held = await claim.handle.stat({ bigint: true });
    if (!same(claim.identity, { dev: held.dev, ino: held.ino, birth: held.birthtimeNs }))
      throw new Error('SESSION_SCRATCH_CONTAINMENT_FENCE_CHANGED');
  }
  if (!same(claim.identity, await directoryIdentity(claim.path)))
    throw new Error('SESSION_SCRATCH_CONTAINMENT_FENCE_CHANGED');
}

async function releaseClaim(claim: Claim, retire?: () => Promise<void>): Promise<void> {
  if (claim.attempted) return;
  claim.attempted = true;
  try {
    await assertClaimIdentity(claim);
    await rmdir(claim.path);
    // Cleanup has already retired the marker. Keep the acquired directory FD
    // open through removal of the now-empty registered removal namespace.
    await retire?.();
  } finally {
    await claim.handle?.close();
  }
}

async function releaseClaims(claims: Claim[]): Promise<void> {
  let failure: unknown;
  for (const claim of [...claims].reverse()) {
    try {
      await releaseClaim(claim);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/** Interoperates with Launcher scratchWithContainment; no PID/age recovery. */
export async function claimScratchContainment(workspace: string, cleanupOwnerId?: string) {
  let selected = await canonicalScratchWorkspace(workspace);
  const selectedIdentity = await directoryIdentity(selected);
  const ancestors: Ancestor[] = [];
  const parts = selected.slice(parse(selected).root.length).split(sep).filter(Boolean);
  let directory = parse(selected).root;
  for (let index = 0; index < parts.length; index++) {
    directory = join(directory, parts[index]!);
    if (index >= 2 && parts[index - 1] === 'sessions' && parts[index - 2] === 'tmp') {
      if (ancestors.length >= 64) throw new Error('SESSION_SCRATCH_CONTAINMENT_INVALID');
      const ancestor = await ancestorIdentity(
        directory,
        directory === selected && cleanupOwnerId !== undefined,
      );
      if (
        directory === selected &&
        cleanupOwnerId !== undefined &&
        ancestor.ownerId !== cleanupOwnerId
      )
        throw new Error('SESSION_SCRATCH_CONTAINMENT_INVALID');
      ancestors.push(ancestor);
    }
  }
  const claims: Claim[] = [];
  const revalidate = async () => {
    await canonicalScratchWorkspace(selected);
    if (!same(selectedIdentity, await directoryIdentity(selected)))
      throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
    for (const ancestor of ancestors) {
      const current = await ancestorIdentity(
        ancestor.directory,
        ancestor.directory === selected && cleanupOwnerId !== undefined,
      );
      if (!same(ancestor.identity, current.identity) || ancestor.provenance !== current.provenance)
        throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
    }
    for (const claim of claims) if (!claim.attempted) await assertClaimIdentity(claim);
  };
  try {
    // Ancestors are discovered in path order. Containment always precedes the
    // owner's controller/association operation, and never spans a service lifetime.
    for (const ancestor of ancestors) {
      const path = join(ancestor.directory, containmentFenceName);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error('SESSION_SCRATCH_CONTAINMENT_BUSY');
        throw error;
      }
      const claim: Claim = {
        directory: ancestor.directory,
        path,
        identity: await directoryIdentity(path),
        attempted: false,
      };
      claims.push(claim);
      await privateDirectory(path, false);
      claim.handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const held = await claim.handle.stat({ bigint: true });
      if (!same(claim.identity, { dev: held.dev, ino: held.ino, birth: held.birthtimeNs }))
        throw new Error('SESSION_SCRATCH_CONTAINMENT_FENCE_CHANGED');
      const current = await ancestorIdentity(
        ancestor.directory,
        ancestor.directory === selected && cleanupOwnerId !== undefined,
      );
      if (!same(ancestor.identity, current.identity) || ancestor.provenance !== current.provenance)
        throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
    }
    await revalidate();
  } catch (error) {
    await releaseClaims(claims);
    throw error;
  }
  return {
    revalidate,
    async relocate(from: string, to: string) {
      const ancestor = ancestors.find((value) => value.directory === from);
      const claim = claims.find((value) => value.directory === from);
      if (selected !== from || !cleanupOwnerId || !ancestor || !claim)
        throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
      await privateDirectory(to, false);
      if (!same(ancestor.identity, await directoryIdentity(to)))
        throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
      selected = to;
      ancestor.directory = to;
      claim.directory = to;
      claim.path = join(to, containmentFenceName);
    },
    async retireCurrent(at: string, remove: () => Promise<void>) {
      const claim = claims.at(-1);
      const ancestor = ancestors.at(-1);
      if (
        !cleanupOwnerId ||
        !claim ||
        !ancestor ||
        claim.directory !== at ||
        !same(ancestor.identity, await directoryIdentity(at))
      )
        throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
      await releaseClaim(claim, remove);
    },
    release: () => releaseClaims(claims),
  };
}

export async function withScratchContainment<T>(
  workspace: string,
  publish: () => T | Promise<T>,
): Promise<T> {
  const guard = await claimScratchContainment(workspace);
  try {
    return await publish();
  } finally {
    await guard.release();
  }
}

/** Detached history may outlive its cwd; publishing it never allocates scratch. */
export async function withHistoryScratchContainment<T>(
  workspace: string,
  publish: () => T | Promise<T>,
): Promise<T> {
  if (!isAbsolute(workspace)) throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  try {
    await directoryIdentity(workspace);
    return withScratchContainment(workspace, publish);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (workspace !== resolve(workspace)) throw new Error('SESSION_SCRATCH_UNSAFE_PATH');

  let existing = workspace;
  let missing = workspace;
  let identity: Identity;
  for (;;) {
    try {
      identity = await directoryIdentity(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = existing;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  // This prefix is only observed: system-owned ordinary ancestors (including /)
  // do not acquire session ownership or become allocation/deletion targets.
  const revalidate = async () => {
    if (
      (await realpath(existing)) !== existing ||
      !same(identity, await directoryIdentity(existing))
    )
      throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
    const absent = await lstat(missing).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return true;
      },
    );
    if (!absent) throw new Error('SESSION_SCRATCH_CONTAINMENT_CHANGED');
  };
  await revalidate();

  let deepestOwner: string | undefined;
  let ownerCount = 0;
  const parts = workspace.slice(parse(workspace).root.length).split(sep).filter(Boolean);
  let directory = parse(workspace).root;
  for (let index = 0; index < parts.length; index++) {
    directory = join(directory, parts[index]!);
    if (index >= 2 && parts[index - 1] === 'sessions' && parts[index - 2] === 'tmp') {
      if (++ownerCount > 64) throw new Error('SESSION_SCRATCH_CONTAINMENT_INVALID');
      deepestOwner = directory;
    }
  }
  // Scan the full lexical target, even beyond the missing frontier. Claiming the
  // deepest owner validates every reserved ancestor; absent/unknown owners fail.
  const guard = deepestOwner ? await claimScratchContainment(deepestOwner) : undefined;
  try {
    await revalidate();
    return await publish();
  } finally {
    await guard?.release();
  }
}
