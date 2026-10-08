/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { UpgradeStatus } from '../../../shared/contracts/upgrade.js';

/** A new server identity proves a restart even when the browser misses the offline window. */
export async function waitForUpgrade(
  instanceId: string,
  status: (signal: AbortSignal) => Promise<UpgradeStatus>,
  signal: AbortSignal,
  delay = 1_000,
  timeout = 15 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let current: UpgradeStatus | undefined;
    try {
      current = await status(AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
    } catch {
      // The relay and reverse proxy can be temporarily unavailable during restart.
      signal.throwIfAborted();
    }
    if (current && current.instanceId !== instanceId) return;
    if (current?.phase === 'failed')
      throw new Error(current.message ?? 'Upgrade failed. Check the Gestalt update log.');
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error(
    'Mobile has not reconnected yet. Check the Gestalt update-restart.log and reload when it is ready.',
  );
}
