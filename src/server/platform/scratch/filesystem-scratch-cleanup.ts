/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
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
import {
  claimScratchContainment,
  containmentFenceName,
  type InheritedContainment,
} from './containment-fence.js';
import { workspacePublicationName } from './workspace-publication.js';
import {
  hasRuntimeOwner,
  runtimeIdentity,
  runtimeMarkerName,
  validateRuntime,
} from './runtime-root.js';

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
  ) {
    // A retained session can outlive its workspace (including Self DEBUG).
    // Only an absent workspace is already clean; existing links and invalid
    // paths must still pass the normal canonical-path checks below.
    if (isAbsolute(session.workspacePath)) {
      try {
        await lstat(session.workspacePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (
            process.getuid &&
            (await hasRuntimeOwner({
              workspacePath: session.workspacePath,
              ownerId: mobileScratchOwnerId(session.id),
            }))
          )
            throw new Error('SESSION_CLEANUP_FAILED');
          return;
        }
        throw error;
      }
    }
    const counts = await this.cleanWorkspace(
      session.workspacePath,
      protectedSessions,
      mobileScratchOwnerId(session.id),
      authorized,
    );
    if (counts.skipped || counts.failed) throw new Error('SESSION_CLEANUP_FAILED');
  }
  async canonicalWorkspace(path: string): Promise<string> {
    return canonicalScratchWorkspace(path);
  }

  async cleanWorkspace(
    workspacePath: string,
    protectedSessions: () => readonly ScratchSessionOwner[],
    onlyOwnerId?: string,
    authorized?: () => boolean,
    authorizedSessionId?: string,
    inherited?: InheritedContainment,
  ) {
    await this.canonicalWorkspace(workspacePath);
    const counts = emptyScratchCounts();
    const workspaceName = basename(workspacePath) || 'root workspace';
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
        containment = await claimScratchContainment(directory, ownerId, inherited);
        release = await claimOwnerFence(directory);
        const marker = await readManagedScratchOwner(directory, workspacePath, ownerId);
        await this.assertProtection(
          directory,
          join(container, ownerId),
          marker,
          protectedSessions,
          authorized,
          onlyOwnerId ??
            (authorizedSessionId ? mobileScratchOwnerId(authorizedSessionId) : undefined),
        );
        await this.releasedLeases(directory, marker);
        if (authorized) {
          await this.retireNestedNamespaces(
            directory,
            protectedSessions,
            authorized,
            authorizedSessionId,
            containment,
          );
          if (marker.runtime && (await validateRuntime(marker, marker.runtime, true)))
            await this.retireNestedNamespaces(
              marker.runtime.directory,
              protectedSessions,
              authorized,
              authorizedSessionId,
              containment,
            );
        }
        await this.validatePayload(directory);
        if (marker.runtime) {
          const present = await validateRuntime(marker, marker.runtime, true);
          if (present) {
            await this.assertProtection(
              directory,
              join(container, ownerId),
              marker,
              protectedSessions,
              authorized,
              onlyOwnerId ??
                (authorizedSessionId ? mobileScratchOwnerId(authorizedSessionId) : undefined),
            );
            await this.validatePayload(marker.runtime.directory);
          }
        }
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
              onlyOwnerId ??
                (authorizedSessionId ? mobileScratchOwnerId(authorizedSessionId) : undefined),
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
          onlyOwnerId ??
            (authorizedSessionId ? mobileScratchOwnerId(authorizedSessionId) : undefined),
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
        await this.retireRuntime(directory, marker);
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
        if (
          (outcome === 'failed' ||
            (outcome === 'skipped' && authorized && managedScratchOwnerId(name))) &&
          !/[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(workspaceName)
        ) {
          (counts.failedFolders ??= []).push({
            workspaceName,
            relativePath: `tmp/sessions/${basename(directory)}`,
          });
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

  /** Final workspace authority can retire positively attributed nested namespaces,
   * but every nested roster, lease, inode and fence still has to pass its gate. */
  async retireNestedNamespaces(
    directory: string | Buffer,
    protectedSessions: () => readonly ScratchSessionOwner[],
    authorized: () => boolean,
    authorizedSessionId?: string,
    inherited?: InheritedContainment,
    skipContainer = false,
    depth = 0,
    budget = { entries: 0 },
  ): Promise<void> {
    if (depth > 128 || !authorized()) reject('protected');
    let entries;
    try {
      entries = await readdir(directory, { encoding: 'buffer', withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (++budget.entries > 100000) reject('unrecognized');
      const name = entry.name.toString();
      if (skipContainer && name === 'sessions') continue;
      const path = payloadPath(directory, entry.name),
        info = await lstat(path);
      if (process.getuid && info.uid !== process.getuid()) reject('unsafe');
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (name === 'tmp') {
        const workspace = directory.toString();
        if (Buffer.isBuffer(directory) && !Buffer.from(workspace).equals(directory))
          reject('unrecognized');
        const counts = await this.cleanWorkspace(
          workspace,
          protectedSessions,
          undefined,
          authorized,
          authorizedSessionId,
          inherited,
        );
        if (counts.skipped || counts.failed) reject('unrecognized');
        const container = join(workspace, 'tmp', 'sessions');
        try {
          await privateDirectory(container, false);
          const remaining = await readdir(container);
          if (remaining.some((child) => child !== '.gitignore')) reject('unrecognized');
          if (remaining.includes('.gitignore')) await rm(join(container, '.gitignore'));
          await rmdir(container);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await this.retireNestedNamespaces(
        path,
        protectedSessions,
        authorized,
        authorizedSessionId,
        inherited,
        name === 'tmp',
        depth + 1,
        budget,
      );
    }
  }

  private async retireRuntime(directory: string, marker: ManagedScratchOwner) {
    if (!marker.runtime) return;
    const runtime = marker.runtime;
    if (!(await validateRuntime(marker, runtime, true))) return;
    // Persist retirement intent before either authority record is removed.
    // After a crash an absent runtime is acceptable only with this exact record;
    // a replacement inode or a nonempty directory without its marker is retained.
    if (!runtime.retiring) {
      marker.runtime = { ...runtime, retiring: true };
      const staging = join(directory, `.owner-${randomUUID()}.json`);
      const handle = await open(staging, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(marker)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, join(directory, scratchMarkerName));
    }
    const children = await readdir(runtime.directory, { encoding: 'buffer' });
    const attributed = children.some((child) => child.toString() === runtimeMarkerName);
    if (!attributed && children.length) reject('unrecognized');
    if (attributed) {
      await validateRuntime(marker, marker.runtime, true);
      for (const child of children) {
        if (child.toString() !== runtimeMarkerName)
          await rm(payloadPath(runtime.directory, child), { recursive: true });
      }
      await validateRuntime(marker, marker.runtime, true);
      await rm(join(runtime.directory, runtimeMarkerName));
    }
    if ((await runtimeIdentity(runtime.directory)) !== runtime.identity) reject('unsafe');
    await rmdir(runtime.directory);
  }

  private async assertProtection(
    directory: string,
    logicalDirectory: string,
    marker: ManagedScratchOwner,
    protectedSessions: () => readonly ScratchSessionOwner[],
    authorized?: () => boolean,
    authorizedOwnerId?: string,
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
      if (
        authorized &&
        marker.ownerId === authorizedOwnerId &&
        marker.ownerKind === 'mobile-session' &&
        session.id === marker.sessionId
      )
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
          [directory, logicalDirectory, ...(marker.runtime ? [marker.runtime.directory] : [])].some(
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
      if (child.toString() === workspacePublicationName) reject('busy');
      if (++budget.entries > 100_000) reject('unrecognized');
      if (
        directory !== root &&
        [
          scratchMarkerName,
          runtimeMarkerName,
          '.controller-lock',
          '.association-lock',
          containmentFenceName,
        ].includes(child.toString())
      )
        reject('unrecognized');
      const path = payloadPath(directory, child);
      const info = await lstat(path);
      if (
        (process.getuid && info.uid !== process.getuid()) ||
        (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink() && !info.isSocket()) ||
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
