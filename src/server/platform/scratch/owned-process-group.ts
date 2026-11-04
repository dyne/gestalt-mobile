/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Only for a group created by this runtime with detached:true; never persisted PIDs. */
export async function stopOwnedProcessGroup(
  child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>,
  graceMs = 2000,
  confirmationMs = 1000,
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  if (!child.pid) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    return false;
  }
  const group = -child.pid;
  const signal = (value: NodeJS.Signals | 0): 'present' | 'absent' | 'unknown' => {
    try {
      process.kill(group, value);
      return 'present';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
    }
  };
  const wait = async (timeout: number) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const status = signal(0);
      if (status !== 'present') return status;
      if (Date.now() >= deadline) return 'present';
      await delay(Math.min(20, deadline - Date.now()));
    }
  };
  // Once the leader was already reaped, its numeric group ID may have been reused.
  // Read-only absence can prove release; a present group cannot prove ownership.
  if (child.exitCode !== null || child.signalCode !== null)
    return (await wait(confirmationMs)) === 'absent';
  const term = signal('SIGTERM');
  if (term !== 'present') return term === 'absent';
  const graceful = await wait(graceMs);
  if (graceful !== 'present') return graceful === 'absent';
  if (child.exitCode !== null || child.signalCode !== null)
    return (await wait(confirmationMs)) === 'absent';
  const forced = signal('SIGKILL');
  if (forced !== 'present') return forced === 'absent';
  return (await wait(confirmationMs)) === 'absent';
}
