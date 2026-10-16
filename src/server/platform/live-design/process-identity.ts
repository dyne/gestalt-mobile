/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  fstatSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { open } from 'node:fs/promises';

const fileIdentity = (info: BigIntStats) =>
  JSON.stringify(
    [
      info.dev,
      info.ino,
      info.mode,
      info.uid,
      info.gid,
      info.nlink,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
    ].map(String),
  );

/** Fresh bytes for ONE admission operation. Every physical connection has its
 * own operation. Aliases share actual inode observations, never authority across
 * calls. A connect consumes the scope; control verification closes it directly.
 */
export class ConnectionFileVerification {
  readonly #cancellation = new AbortController();
  #readOperations = 0;
  #bytesRead = 0;
  #consumed = false;
  #binding?: string;
  readonly #roles = new Set<string>();
  readonly #files = new Map<
    string,
    { identity: string; pending: Promise<string>; digest?: string }
  >();
  assertOpen(): void {
    if (this.#consumed) throw new Error('LIVE_CONNECTION_VERIFICATION_CONSUMED');
  }
  statistics(): Readonly<{ readOperations: number; bytesRead: number }> {
    return { readOperations: this.#readOperations, bytesRead: this.#bytesRead };
  }
  claim(sessionId: string, generation: number, appRoot: string, role: string): void {
    this.assertOpen();
    const binding = JSON.stringify([sessionId, generation, appRoot]);
    if (
      (this.#binding && this.#binding !== binding) ||
      this.#roles.has(role) ||
      !['helper', 'devserver'].includes(role)
    )
      throw new Error('LIVE_CONNECTION_VERIFICATION_SCOPE');
    this.#binding = binding;
    this.#roles.add(role);
  }
  consume(): void {
    this.assertOpen();
    this.close();
  }
  close(): void {
    this.#consumed = true;
    this.#cancellation.abort();
    this.#files.clear();
  }
  verifiedDigest(path: string): string {
    this.assertOpen();
    const info = statSync(path, { bigint: true });
    const entry = this.#files.get(`${info.dev}:${info.ino}`);
    if (!entry?.digest || entry.identity !== fileIdentity(info))
      throw new Error('LIVE_CONNECTION_FILE_CHANGED');
    return entry.digest;
  }
  async digest(path: string, signal: AbortSignal): Promise<string> {
    this.assertOpen();
    signal = AbortSignal.any([signal, this.#cancellation.signal]);
    signal.throwIfAborted();
    const handle = await open(path, 'r');
    let owned = true;
    try {
      this.assertOpen();
      signal.throwIfAborted();
      const info = fstatSync(handle.fd, { bigint: true });
      if (!info.isFile()) throw new Error('LIVE_CONNECTION_FILE_CHANGED');
      const key = `${info.dev}:${info.ino}`,
        identity = fileIdentity(info);
      let entry = this.#files.get(key);
      if (entry && entry.identity !== identity) throw new Error('LIVE_CONNECTION_FILE_CHANGED');
      if (!entry) {
        this.#readOperations++;
        const observation = {
          identity,
          pending: Promise.resolve(''),
          digest: undefined as string | undefined,
        };
        observation.pending = (async () => {
          try {
            const hash = createHash('sha256');
            for await (const bytes of handle.createReadStream({
              autoClose: false,
              signal,
              highWaterMark: 65536,
            })) {
              this.#bytesRead += bytes.length;
              hash.update(bytes);
            }
            if (fileIdentity(fstatSync(handle.fd, { bigint: true })) !== identity)
              throw new Error('LIVE_CONNECTION_FILE_CHANGED');
            observation.digest = hash.digest('hex');
            return observation.digest;
          } finally {
            await handle.close();
          }
        })();
        owned = false;
        this.#files.set(key, observation);
        entry = observation;
      }
      const digest = await entry.pending;
      signal.throwIfAborted();
      this.assertOpen();
      if (fileIdentity(statSync(path, { bigint: true })) !== identity)
        throw new Error('LIVE_CONNECTION_FILE_CHANGED');
      return digest;
    } finally {
      if (owned) await handle.close();
    }
  }
}

export type LiveProcessIdentity = Readonly<{
  pid: number;
  birth: string;
  bootId: string;
  uid: number;
  executable: string;
  executableDigest: string;
  cwd: string;
  namespaces: Readonly<Record<'mnt' | 'user' | 'pid' | 'net', string>>;
}>;

/** Full content verification without large synchronous reads on the controller. */
export async function liveFileDigest(
  path: string,
  signal: AbortSignal,
  files?: ConnectionFileVerification,
): Promise<string> {
  if (files) return files.digest(path, signal);
  signal.throwIfAborted();
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path, { signal, highWaterMark: 65536 }))
    digest.update(bytes);
  signal.throwIfAborted();
  return digest.digest('hex');
}

function liveProcessMetadata(pid: number) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error();
  const root = `/proc/${pid}`;
  const text = readFileSync(`${root}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const birth = fields[19];
  const uid = Number(readFileSync(`${root}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]);
  if (!birth || !/^\d+$/.test(birth) || fields[0] === 'Z' || !Number.isSafeInteger(uid))
    throw new Error();
  return {
    pid,
    birth,
    uid,
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    executable: realpathSync(`${root}/exe`),
    cwd: realpathSync(`${root}/cwd`),
    namespaces: {
      mnt: readlinkSync(`${root}/ns/mnt`),
      user: readlinkSync(`${root}/ns/user`),
      pid: readlinkSync(`${root}/ns/pid`),
      net: readlinkSync(`${root}/ns/net`),
    },
  };
}

/** Fixed controller comparison fields only; never process adoption authority. */
export function observeControllerIsolation(): Pick<LiveProcessIdentity, 'uid' | 'namespaces'> {
  const { uid, namespaces } = liveProcessMetadata(process.pid);
  return { uid, namespaces };
}

/** Lifetime fence after full digest verification, never a substitute for it. */
export function assertObservedProcessMetadata(identity: LiveProcessIdentity): void {
  const expected = { ...identity, executableDigest: undefined };
  if (JSON.stringify(liveProcessMetadata(identity.pid)) !== JSON.stringify(expected))
    throw new Error('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
}

/** Same full executable/birth identity; fence metadata again across asynchronous IO. */
export async function observeLiveProcessAsync(
  pid: number,
  signal: AbortSignal,
  files?: ConnectionFileVerification,
): Promise<LiveProcessIdentity> {
  try {
    const before = liveProcessMetadata(pid);
    const executableDigest = await liveFileDigest(`/proc/${pid}/exe`, signal, files);
    if (JSON.stringify(before) !== JSON.stringify(liveProcessMetadata(pid))) throw new Error();
    return Object.freeze({
      pid: before.pid,
      birth: before.birth,
      uid: before.uid,
      bootId: before.bootId,
      executable: before.executable,
      executableDigest,
      cwd: before.cwd,
      namespaces: Object.freeze(before.namespaces),
    });
  } catch {
    throw new Error('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  }
}

/** Observation alone never grants ownership. Callers retain the actual ChildProcess handle. */
export function observeLiveProcess(pid: number): LiveProcessIdentity {
  try {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error();
    const root = `/proc/${pid}`;
    const stat = readFileSync(`${root}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const birth = fields[19];
    const uid = Number(readFileSync(`${root}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]);
    if (!birth || !/^\d+$/.test(birth) || fields[0] === 'Z' || !Number.isSafeInteger(uid))
      throw new Error();
    const identity = Object.freeze({
      pid,
      birth,
      uid,
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      executable: realpathSync(`${root}/exe`),
      executableDigest: createHash('sha256')
        .update(readFileSync(`${root}/exe`))
        .digest('hex'),
      cwd: realpathSync(`${root}/cwd`),
      namespaces: Object.freeze({
        mnt: readlinkSync(`${root}/ns/mnt`),
        user: readlinkSync(`${root}/ns/user`),
        pid: readlinkSync(`${root}/ns/pid`),
        net: readlinkSync(`${root}/ns/net`),
      }),
    });
    // CPU/accounting fields change normally; only birth and state fence identity.
    const after = readFileSync(`${root}/stat`, 'utf8');
    const next = after.slice(after.lastIndexOf(')') + 2).split(' ');
    if (next[19] !== birth || next[0] === 'Z') throw new Error();
    return identity;
  } catch {
    throw new Error('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  }
}

export type OwnedProcessBirth = Readonly<{ pid: number; birth: string; bootId: string }>;
/** Kernel ancestry observation under an already-owned process, never kill/adoption authority. */
export function observeOwnedDescendants(owner: LiveProcessIdentity): readonly OwnedProcessBirth[] {
  if (JSON.stringify(observeLiveProcess(owner.pid)) !== JSON.stringify(owner))
    throw new Error('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  if (pids.length > 8192) throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
  const rows = new Map<number, { parent: number; birth: string; state: string }>();
  for (const value of pids) {
    try {
      const text = readFileSync(`/proc/${value}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      rows.set(Number(value), { parent: Number(fields[1]), birth: fields[19]!, state: fields[0]! });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
    }
  }
  const children: OwnedProcessBirth[] = [];
  for (const [pid, row] of rows) {
    if (pid === owner.pid || row.state === 'Z') continue;
    let parent = row.parent;
    for (let depth = 0; depth < 64 && parent > 0; depth++) {
      if (parent === owner.pid) {
        children.push({ pid, birth: row.birth, bootId: owner.bootId });
        break;
      }
      parent = rows.get(parent)?.parent ?? 0;
    }
  }
  if (JSON.stringify(observeLiveProcess(owner.pid)) !== JSON.stringify(owner))
    throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
  return children;
}
export function observedBirthExited(identity: OwnedProcessBirth): boolean {
  if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== identity.bootId)
    return true;
  try {
    const text = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return fields[19] !== identity.birth || fields[0] === 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
  }
}
