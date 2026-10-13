/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';

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
