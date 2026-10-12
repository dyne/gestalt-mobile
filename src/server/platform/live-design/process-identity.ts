/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';

export type LiveProcessIdentity = Readonly<{
  pid: number;
  birth: string;
  bootId: string;
  uid: number;
  executable: string;
  executableDigest: string;
  cwd: string;
  namespaces: Readonly<Record<'mnt' | 'user' | 'pid', string>>;
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
