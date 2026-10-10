/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { LiveControls } from '../application/controls.js';
import type { LiveFence, LiveOwnershipStore, LiveRun } from '../application/ownership.js';

export type LiveStopDependencies = {
  owners: LiveOwnershipStore;
  controls: LiveControls;
  /** Owned resources only; each method must be idempotent under the supplied fence. */
  resources: {
    remove(run: LiveRun): Promise<void>;
    revoke(run: LiveRun): Promise<void>;
    cleanup(run: LiveRun): Promise<void>;
    /** Actual route/auth/helper/process reconciliation, including pending results and descendants. */
    verifyClean(run: LiveRun): Promise<void>;
  };
};

/** Release only after cleanup proof. A crash retains the durable phase and ownership. */
export async function stopLive(deps: LiveStopDependencies, fence: LiveFence): Promise<LiveRun> {
  let run = deps.owners.assert(fence);
  if (run.state !== 'idle') {
    if (run.state !== 'stopping') run = deps.owners.mutate(run, { event: 'stop' });
    try {
      for (const name of ['remove', 'revoke', 'cleanup', 'verifyClean'] as const) {
        run = deps.owners.mutate(run, { event: 'phase', phase: `stop:${name}:intent` });
        await deps.resources[name](run);
        deps.owners.assert(run);
        run = deps.owners.mutate(run, { event: 'phase', phase: `stop:${name}:ack` });
      }
      run = deps.owners.mutate(run, { event: 'cleaned' });
    } catch (error) {
      // A newer controller/Stop owns a stale callback; it cannot mark or clean that generation.
      deps.owners.assert(run);
      deps.owners.mutate(run, { event: 'recover', code: 'LIVE_CLEANUP_REQUIRED' });
      throw error;
    }
  }
  run = deps.owners.assertRestorable(run);
  if (!run.controlsRestored) {
    // Synchronous current-intent comparison in the real adapter precedes timer rehydration.
    deps.controls.restore(run);
    run = deps.owners.mutate(run, { event: 'controlsRestored' });
  }
  return run;
}
