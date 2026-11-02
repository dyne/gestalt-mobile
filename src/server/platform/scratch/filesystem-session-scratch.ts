/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  SessionScratch,
  SessionScratchContext,
  ServiceScratchLease,
} from '../../features/sessions/application/session-scratch.js';

export const scratchMarkerName = '.gestalt-owner.json';
export const scratchContextVariable = 'GESTALT_SESSION_TMP_CONTEXT';

export type ScratchMarker = {
  schemaVersion: 1;
  ownerKind: 'mobile-session' | 'workspace-service';
  ownerId: string;
  workspacePath: string;
  sessionId: string;
  createdAt: string;
  authority: { kind: 'mobile-roster'; sessionId: string } | { kind: 'lease'; leaseId: string };
  providerThreads: { provider: 'codex' | 'kimi'; threadId: string }[];
};

function validId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value))
    throw new Error('SESSION_SCRATCH_INVALID_ID');
}

export function mobileScratchOwnerId(sessionId: string): string {
  validId(sessionId);
  return `mobile-${createHash('sha256').update(sessionId).digest('hex')}`;
}

/** Reject links and foreign directories; never repair their permissions or contents. */
async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  let created = false;
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  if (process.getuid && info.uid !== process.getuid())
    throw new Error('SESSION_SCRATCH_FOREIGN_OWNER');
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700)
    throw new Error('SESSION_SCRATCH_NOT_PRIVATE');
  return created;
}

async function readMarker(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 16384 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw new Error('SESSION_SCRATCH_UNSAFE_MARKER');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

function validateMarker(value: unknown, expected: ScratchMarker): ScratchMarker {
  const marker = value as ScratchMarker;
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    marker.ownerKind !== expected.ownerKind ||
    marker.ownerId !== expected.ownerId ||
    marker.workspacePath !== expected.workspacePath ||
    marker.sessionId !== expected.sessionId ||
    JSON.stringify(marker.authority) !== JSON.stringify(expected.authority) ||
    typeof marker.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(marker.createdAt)) ||
    !Array.isArray(marker.providerThreads) ||
    marker.providerThreads.some(
      (thread) =>
        !thread ||
        !['codex', 'kimi'].includes(thread.provider) ||
        typeof thread.threadId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(thread.threadId),
    )
  )
    throw new Error('SESSION_SCRATCH_MARKER_MISMATCH');
  return marker;
}

export class FilesystemSessionScratch implements SessionScratch {
  private readonly pending = new Map<string, Promise<unknown>>();

  /** One lease per owned service process, independent of its first caller. */
  async allocateService(workspacePath: string, consumer: string): Promise<ServiceScratchLease> {
    validId(consumer);
    const leaseId = randomUUID();
    const ownerId = `service-${randomUUID()}`;
    const { context } = await this.prepare({ id: ownerId, workspacePath }, leaseId);
    const leases = join(context.directory, 'leases');
    await privateDirectory(leases, true);
    const path = join(leases, `${leaseId}.json`);
    const record = {
      schemaVersion: 1,
      ownerId,
      workspacePath: context.workspacePath,
      leaseId,
      state: 'active',
      processIdentity: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      consumers: [consumer],
    };
    const publish = async (initial: boolean) => {
      const staging = initial ? path : join(leases, `.${randomUUID()}.json`);
      const handle = await open(staging, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!initial) await rename(staging, path);
    };
    await publish(true);
    let released = false;
    return {
      ...context,
      release: async () => {
        if (released) return;
        record.state = 'released';
        record.consumers = [];
        record.updatedAt = new Date().toISOString();
        await privateDirectory(context.directory, false);
        await privateDirectory(leases, false);
        await publish(false);
        released = true;
      },
    };
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.pending.set(key, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(key) === result) this.pending.delete(key);
    }
  }

  async allocate(
    session: Readonly<{ id: string; workspacePath: string }>,
  ): Promise<SessionScratchContext> {
    return this.serialized(`${session.workspacePath}\0${session.id}`, async () => {
      const { context } = await this.prepare(session);
      return context;
    });
  }

  async associateProviderThread(
    session: Readonly<{ id: string; workspacePath: string }>,
    provider: 'codex' | 'kimi',
    threadId: string,
  ): Promise<void> {
    validId(threadId);
    if (!['codex', 'kimi'].includes(provider)) throw new Error('SESSION_SCRATCH_INVALID_PROVIDER');
    await this.serialized(`${session.workspacePath}\0${session.id}`, async () => {
      const { context, marker } = await this.prepare(session);
      if (
        marker.providerThreads.some(
          (thread) => thread.provider === provider && thread.threadId === threadId,
        )
      )
        return;
      marker.providerThreads.push({ provider, threadId });
      const staging = join(context.directory, `.owner-${randomUUID()}.json`);
      const handle = await open(staging, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(marker)}\n`);
        await handle.sync();
        await handle.close();
        await privateDirectory(context.directory, false);
        await rename(staging, join(context.directory, scratchMarkerName));
      } finally {
        await handle.close();
        await unlink(staging).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
  }

  private async prepare(
    session: Readonly<{ id: string; workspacePath: string }>,
    leaseId?: string,
  ) {
    const ownerId = leaseId ? session.id : mobileScratchOwnerId(session.id);
    if (!isAbsolute(session.workspacePath)) throw new Error('SESSION_SCRATCH_WORKSPACE_REQUIRED');
    const workspacePath = await realpath(session.workspacePath);
    if (workspacePath !== resolve(session.workspacePath))
      throw new Error('SESSION_SCRATCH_UNSAFE_WORKSPACE');
    if (!(await lstat(workspacePath)).isDirectory())
      throw new Error('SESSION_SCRATCH_WORKSPACE_REQUIRED');
    const temporary = join(workspacePath, 'tmp');
    // A user-owned tmp sibling may already be public; it is not ours to chmod.
    try {
      await mkdir(temporary, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const temporaryInfo = await lstat(temporary);
    if (
      !temporaryInfo.isDirectory() ||
      temporaryInfo.isSymbolicLink() ||
      (await realpath(temporary)) !== temporary ||
      (process.getuid && temporaryInfo.uid !== process.getuid())
    )
      throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
    const sessions = join(temporary, 'sessions');
    await privateDirectory(sessions, true);
    // Git ignores this file too. Existing user rules are never replaced.
    const ignore = await open(
      join(sessions, '.gitignore'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      return undefined;
    });
    if (ignore) {
      try {
        await ignore.writeFile('*\n');
      } finally {
        await ignore.close();
      }
    }
    const directory = join(sessions, ownerId);
    const created = await privateDirectory(directory, true);
    const markerPath = join(directory, scratchMarkerName);
    const expected: ScratchMarker = {
      schemaVersion: 1,
      ownerKind: leaseId ? 'workspace-service' : 'mobile-session',
      ownerId,
      workspacePath,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
      authority: leaseId
        ? { kind: 'lease', leaseId }
        : { kind: 'mobile-roster', sessionId: session.id },
      providerThreads: [],
    };
    let marker: ScratchMarker;
    if (created) {
      try {
        const handle = await open(markerPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(expected)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        marker = expected;
      } catch (error) {
        // Remove only this invocation's still-empty allocation; preserve uncertainty.
        await rmdir(directory).catch(() => undefined);
        throw error;
      }
    } else {
      marker = validateMarker(await readMarker(markerPath), expected);
    }
    await privateDirectory(directory, false);
    const context: SessionScratchContext = {
      workspacePath,
      ownerId,
      directory,
      environment: {
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        [scratchContextVariable]: JSON.stringify({
          schemaVersion: 1,
          workspacePath,
          ownerId,
          directory,
          markerPath,
        }),
      },
    };
    return { context, marker };
  }
}
