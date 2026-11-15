/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateDirectory, readMarker } from './scratch-filesystem.js';

export const runtimeMarkerName = '.gestalt-runtime.json';
export const runtimeRootMaxBytes = 48;

export type RuntimeBinding = Readonly<{
  directory: string;
  token: string;
  identity: string;
  retiring?: true;
}>;
export type RuntimeOwner = Readonly<{
  ownerId: string;
  workspacePath: string;
}>;

function reject(): never {
  throw new Error('SESSION_SCRATCH_RUNTIME_INVALID');
}

export async function runtimeContainer(): Promise<string> {
  if (!process.getuid) reject();
  // /tmp is deliberately independent of TMPDIR and workspace depth. On macOS
  // resolve its system alias once; payload directories themselves are not links.
  return join(await realpath('/tmp'), `gs-${process.getuid()}`);
}

export async function runtimeIdentity(directory: string): Promise<string> {
  await privateDirectory(directory, false);
  const info = await lstat(directory, { bigint: true });
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

export function runtimeRecord(owner: RuntimeOwner, runtime: RuntimeBinding) {
  return {
    schemaVersion: 2,
    ownerId: owner.ownerId,
    workspacePath: owner.workspacePath,
    token: runtime.token,
    identity: runtime.identity,
  };
}

/** Only a fresh exclusive directory may become a runtime allocation. */
export async function allocateRuntime(owner: RuntimeOwner): Promise<RuntimeBinding> {
  const container = await runtimeContainer();
  await privateDirectory(container, true);
  for (let attempt = 0; attempt < 16; attempt++) {
    const directory = join(container, randomBytes(10).toString('hex'));
    if (Buffer.byteLength(directory) > runtimeRootMaxBytes)
      throw new Error('SESSION_SCRATCH_RUNTIME_ROOT_TOO_LONG');
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const runtime = {
      directory,
      token: randomBytes(32).toString('hex'),
      identity: await runtimeIdentity(directory),
    };
    const handle = await open(join(directory, runtimeMarkerName), 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(runtimeRecord(owner, runtime))}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return runtime;
  }
  throw new Error('SESSION_SCRATCH_RUNTIME_COLLISION');
}

/** The workspace record and physical root must agree, including inode identity. */
export async function validateRuntime(
  owner: RuntimeOwner,
  runtime: RuntimeBinding,
  allowRetiring = false,
): Promise<boolean> {
  const container = await runtimeContainer();
  if (
    !runtime ||
    typeof runtime.directory !== 'string' ||
    dirname(runtime.directory) !== container ||
    !/^[0-9a-f]{20}$/.test(runtime.directory.slice(container.length + 1)) ||
    Buffer.byteLength(runtime.directory) > runtimeRootMaxBytes ||
    typeof runtime.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(runtime.token) ||
    typeof runtime.identity !== 'string' ||
    !/^\d+:\d+:\d+$/.test(runtime.identity) ||
    (runtime.retiring !== undefined && (runtime.retiring !== true || !allowRetiring))
  )
    reject();
  await privateDirectory(container, false);
  try {
    if ((await runtimeIdentity(runtime.directory)) !== runtime.identity) reject();
  } catch (error) {
    // This flag belongs only to attribution/cleanup. Actual retirement still
    // requires the authoritative roster, released leases and both owner fences.
    if (allowRetiring && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let actual: unknown;
  try {
    actual = await readMarker(join(runtime.directory, runtimeMarkerName));
  } catch (error) {
    if (allowRetiring && runtime.retiring && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return true; // Cleanup may only rmdir this identity, never recursively delete it.
    throw error;
  }
  if (JSON.stringify(actual) !== JSON.stringify(runtimeRecord(owner, runtime))) reject();
  return true;
}

/** A missing workspace does not authorize abandoning an external payload root. */
export async function hasRuntimeOwner(
  owner: Readonly<{ workspacePath: string; ownerId?: string }>,
): Promise<boolean> {
  const container = await runtimeContainer();
  try {
    await privateDirectory(container, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const names = await readdir(container);
  if (names.length > 10000) reject();
  for (const name of names) {
    if (!/^[0-9a-f]{20}$/.test(name)) continue;
    try {
      await privateDirectory(join(container, name), false);
      const record = (await readMarker(join(container, name, runtimeMarkerName))) as RuntimeOwner;
      if (
        record.workspacePath === owner.workspacePath &&
        (owner.ownerId === undefined || record.ownerId === owner.ownerId)
      )
        return true;
    } catch {
      // Unattributable allocations stay untouched. They cannot establish
      // ownership by this workspace or prevent unrelated sessions retiring.
      continue;
    }
  }
  return false;
}

/** Complete encoded endpoint, including its terminating NUL, must fit sun_path. */
export function requireSocketPath(
  path: string,
  capacity = ({ linux: 108, darwin: 104 } as Readonly<Record<string, number>>)[process.platform],
) {
  if (!capacity)
    throw new Error(
      'UNIX_SOCKET_PLATFORM_UNSUPPORTED: no verified pathname capacity for this platform',
    );
  if (path.includes('\0') || Buffer.byteLength(path) + 1 > capacity)
    throw new Error('UNIX_SOCKET_PATH_TOO_LONG: shorten the endpoint name or temporary root');
  return path;
}
