/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  observeLiveProcess,
  observeOwnedDescendants,
  observedBirthExited,
  type LiveProcessIdentity,
  type OwnedProcessBirth,
} from './process-identity.js';
import {
  LIVE_MANAGER_OBSERVATION_MS,
  type OriginalInstalledSource,
} from './installed-launch-contract.js';

function bridgeLeaders(
  owner: LiveProcessIdentity,
  source: OriginalInstalledSource,
): readonly OwnedProcessBirth[] {
  return observeOwnedDescendants(owner).filter((birth) => {
    if (observedBirthExited(birth)) return false;
    try {
      const args = readFileSync(`/proc/${birth.pid}/cmdline`, 'utf8').split('\0');
      if (observedBirthExited(birth)) throw new Error();
      return args.includes(source.path);
    } catch {
      throw new Error('LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED');
    }
  });
}
/** Observe only descendants of the already owned Native birth; this grants no
 * PID-based adoption/termination authority and never scans unrelated argv. */
export function captureOriginalBridge(
  owner: LiveProcessIdentity,
  source?: OriginalInstalledSource,
): readonly OwnedProcessBirth[] {
  if (!source) return [];
  const leaders = bridgeLeaders(owner, source);
  if (!leaders.length) throw new Error('LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED');
  return leaders.flatMap((birth) => {
    const current = observeLiveProcess(birth.pid);
    if (
      current.birth !== birth.birth ||
      current.bootId !== birth.bootId ||
      current.executable !== source.interpreter.path
    )
      throw new Error('LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED');
    return [birth, ...observeOwnedDescendants(current)];
  });
}
export async function assertOriginalBridgeDrained(
  owner: LiveProcessIdentity,
  births: readonly OwnedProcessBirth[],
  source?: OriginalInstalledSource,
): Promise<void> {
  if (!source) return;
  const deadline = Date.now() + LIVE_MANAGER_OBSERVATION_MS;
  while (
    births.some((birth) => !observedBirthExited(birth)) ||
    bridgeLeaders(owner, source).length
  ) {
    if (Date.now() >= deadline) throw new Error('LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED');
    await delay(25);
  }
}
