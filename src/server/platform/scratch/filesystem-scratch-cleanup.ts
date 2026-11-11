/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  emptyScratchCounts,
  type ScratchCleanupStorage,
  type ScratchCleanupReason,
  type ScratchSessionOwner,
} from '../../features/sessions/clean-tmp/use-case.js';
import { mobileScratchOwnerId, privateDirectory, scratchMarkerName } from './scratch-filesystem.js';
import { claimOwnerFence } from './owner-fence.js';
import { isAmbiguousLegacyScratch } from './legacy-scratch-layouts.js';
import {
  canonicalScratchWorkspace,
  managedScratchOwnerId,
  readManagedScratchOwner,
  readManagedScratchLeases,
  type ManagedScratchOwner,
} from './managed-scratch-owner.js';
import { claimScratchContainment, containmentFenceName } from './containment-fence.js';

function reject(reason: ScratchCleanupReason): never {
  throw new Error(`SCRATCH_CLEANUP_${reason}`);
}

/** POSIX payload names need not be UTF-8. Keep their bytes for filesystem calls. */
function payloadPath(directory: string | Buffer, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(directory), Buffer.from(sep), name]);
}

/** Only the managed namespace is traversed. There are no prefix/age/PID legacy recognizers. */
export class FilesystemScratchCleanup implements ScratchCleanupStorage {
  async cleanSession(
    session: ScratchSessionOwner,
    authorized: () => boolean,
    protectedSessions: () => readonly ScratchSessionOwner[],
  ): Promise<'retained' | void> {
    // A retained session can outlive its workspace (including Self DEBUG).
    // Only an absent workspace is already clean; existing links and invalid
    // paths must still pass the normal canonical-path checks below.
    if (isAbsolute(session.workspacePath)) {
      try {
        await lstat(session.workspacePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
    const counts = await this.cleanWorkspace(
      session.workspacePath,
      protectedSessions,
      mobileScratchOwnerId(session.id),
      authorized,
    );
    if (counts.failed || counts.reasons.unsafe) throw new Error('SESSION_CLEANUP_FAILED');
    // Forget retires the roster, not the authority of a borrower or nested owner.
    // Keep protected/indeterminate scratch for later ownership-aware cleanup.
    if (counts.skipped) return 'retained';
  }
  async canonicalWorkspace(path: string): Promise<string> {
    return canonicalScratchWorkspace(path);
  }

  async cleanWorkspace(
    workspacePath: string,
    protectedSessions: () => readonly ScratchSessionOwner[],
    onlyOwnerId?: string,
    authorized?: () => boolean,
  ) {
    await this.canonicalWorkspace(workspacePath);
    const counts = emptyScratchCounts();
    const temporary = join(workspacePath, 'tmp');
    try {
      const info = await lstat(temporary);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(temporary)) !== temporary ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return counts;
      throw error;
    }
    if (!onlyOwnerId) {
      for (const entry of await readdir(temporary, { withFileTypes: true })) {
        if (
          !isAmbiguousLegacyScratch(entry.name) ||
          (!entry.isDirectory() && !entry.isSymbolicLink())
        )
          continue;
        counts.skipped++;
        counts.reasons[entry.isSymbolicLink() ? 'unsafe' : 'unrecognized']++;
      }
    }
    const container = join(temporary, 'sessions');
    try {
      await privateDirectory(container, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return counts;
      throw error;
    }
    for (const name of await readdir(container)) {
      if (name === '.gitignore') continue;
      if (onlyOwnerId && managedScratchOwnerId(name) !== onlyOwnerId) continue;
      let release: ((at?: string) => Promise<void>) | undefined;
      let containment: Awaited<ReturnType<typeof claimScratchContainment>> | undefined;
      let directory = join(container, name);
      let outcome: 'removed' | 'skipped' | 'failed' | undefined;
      try {
        const ownerId = managedScratchOwnerId(name);
        if (!ownerId) reject('unrecognized');
        await privateDirectory(directory, false);
        // A removal reservation/partial allocation is not an owner yet. Inspect
        // its locator before claiming a fence; authority is rechecked below.
        await readManagedScratchOwner(directory, workspacePath, ownerId);
        containment = await claimScratchContainment(directory, ownerId);
        release = await claimOwnerFence(directory);
        const marker = await readManagedScratchOwner(directory, workspacePath, ownerId);
        await this.releasedLeases(directory, marker);
        await this.assertProtection(
          directory,
          join(container, ownerId),
          marker,
          protectedSessions,
          authorized,
        );
        await this.validatePayload(directory);
        await privateDirectory(directory, false);
        await containment.revalidate();
        if (name === ownerId) {
          const retired = join(container, `.cleanup-${ownerId}-${randomUUID()}`);
          // Reserve the random destination exclusively; never replace a collision.
          await mkdir(retired, { mode: 0o700 });
          try {
            await this.assertProtection(
              directory,
              join(container, ownerId),
              marker,
              protectedSessions,
              authorized,
            );
          } catch (error) {
            await rmdir(retired);
            throw error;
          }
          await rename(directory, retired);
          directory = retired;
          // The fence moved with the owner. Never release a replacement at its old path.
          const claimed = release;
          release = () => claimed(retired);
          await containment.relocate(join(container, name), retired);
        }
        await privateDirectory(directory, false);
        await containment.revalidate();
        await this.assertProtection(
          directory,
          join(container, ownerId),
          marker,
          protectedSessions,
          authorized,
        );
        // Keep authority metadata until disposable payload has been removed. A failed
        // payload deletion is retryable; an interrupted metadata retirement is unknown.
        for (const child of await readdir(directory, { encoding: 'buffer' })) {
          if (
            [scratchMarkerName, 'leases', '.controller-lock', containmentFenceName].includes(
              child.toString(),
            )
          )
            continue;
          await rm(payloadPath(directory, child), { recursive: true });
        }
        if ((await readdir(directory)).includes('leases'))
          await rm(join(directory, 'leases'), { recursive: true });
        await rm(join(directory, scratchMarkerName));
        // With marker/payload retired, no publisher can validate this namespace.
        // Remove only our own fence instances, then the still-empty owner directory.
        await release();
        release = undefined;
        await containment.retireCurrent(directory, () => rmdir(directory));
        counts.removed++;
        outcome = 'removed';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = error instanceof Error ? error.message : '';
        const reason: ScratchCleanupReason = message.startsWith('SCRATCH_CLEANUP_')
          ? (message.slice('SCRATCH_CLEANUP_'.length) as ScratchCleanupReason)
          : error instanceof SyntaxError
            ? 'unrecognized'
            : message === 'SESSION_SCRATCH_LEASE_INVALID'
              ? 'lease'
              : ['SESSION_SCRATCH_BUSY', 'SESSION_SCRATCH_CONTAINMENT_BUSY'].includes(message)
                ? 'busy'
                : message.startsWith('SESSION_SCRATCH_') ||
                    ['ELOOP', 'ENOTDIR'].includes(code ?? '')
                  ? 'unsafe'
                  : code === 'ENOENT'
                    ? 'busy'
                    : 'io';
        counts.reasons[reason]++;
        outcome = reason === 'io' ? 'failed' : 'skipped';
        counts[outcome]++;
      } finally {
        if (release) {
          try {
            await release();
          } catch {
            if (outcome !== 'failed') {
              if (outcome) counts[outcome]--;
              counts.failed++;
              outcome = 'failed';
            }
            counts.reasons.io++;
          }
        }
        if (containment) {
          try {
            await containment.release();
          } catch {
            if (outcome !== 'failed') {
              if (outcome) counts[outcome]--;
              counts.failed++;
              outcome = 'failed';
            }
            counts.reasons.io++;
          }
        }
      }
    }
    return counts;
  }

  private async releasedLeases(directory: string, marker: ManagedScratchOwner) {
    if ((await readdir(directory)).includes('.association-lock')) reject('busy');
    const leases = await readManagedScratchLeases(directory, marker);
    if (leases.some((lease) => lease.state !== 'released' || lease.consumers.length !== 0))
      reject('lease');
  }

  private async assertProtection(
    directory: string,
    logicalDirectory: string,
    marker: ManagedScratchOwner,
    protectedSessions: () => readonly ScratchSessionOwner[],
    authorized?: () => boolean,
  ) {
    if (authorized && !authorized()) reject('protected');
    const within = (root: string, path: string) => {
      const suffix = relative(root, path);
      return (
        suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
      );
    };
    for (const session of protectedSessions()) {
      // Only this exact targeted owner's authorized Forget may exclude itself.
      if (authorized && marker.ownerKind === 'mobile-session' && session.id === marker.sessionId)
        continue;
      if (marker.ownerKind === 'mobile-session' && session.id === marker.sessionId)
        reject('protected');
      if (!isAbsolute(session.workspacePath)) reject('unrecognized');
      const paths = new Set([resolve(session.workspacePath)]);
      try {
        paths.add(await realpath(session.workspacePath));
      } catch {
        // Durable canonical locators remain protective even after a retirement.
        // Missing unrelated workspaces are reported by their own scan.
      }
      for (const workspace of paths) {
        const scratch = join(workspace, 'tmp', 'sessions', mobileScratchOwnerId(session.id));
        if (
          [directory, logicalDirectory].some(
            (owner) => within(owner, workspace) || within(owner, scratch),
          )
        )
          reject('protected');
      }
    }
  }

  private async validatePayload(
    directory: string | Buffer,
    root = directory,
    depth = 0,
    budget = { entries: 0 },
  ): Promise<void> {
    if (depth > 128) reject('unrecognized');
    // Even an empty nested namespace is not authority to retire a workspace's
    // contents recursively as another owner's payload.
    if (
      directory !== root &&
      basename(directory.toString()) === 'sessions' &&
      basename(dirname(directory.toString())) === 'tmp'
    )
      reject('unrecognized');
    for (const entry of await readdir(directory, { encoding: 'buffer', withFileTypes: true })) {
      const child = entry.name;
      if (++budget.entries > 100_000) reject('unrecognized');
      if (
        directory !== root &&
        [scratchMarkerName, '.controller-lock', '.association-lock', containmentFenceName].includes(
          child.toString(),
        )
      )
        reject('unrecognized');
      const path = payloadPath(directory, child);
      const info = await lstat(path);
      if (
        (process.getuid && info.uid !== process.getuid()) ||
        (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) ||
        (info.isFile() && info.nlink !== 1)
      )
        reject('unsafe');
      // Payload symlinks (for example npm's .bin entries) are disposable links.
      // lstat never follows them, and rm unlinks them without deleting their targets.
      // Owner paths and authority metadata retain their separate no-link checks.
      if (info.isDirectory()) await this.validatePayload(path, root, depth + 1, budget);
    }
  }
}
