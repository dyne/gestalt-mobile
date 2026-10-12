/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { LiveFence, LiveOwnershipStore, LiveRun } from '../application/ownership.js';

export type LiveResumeDependencies = {
  owners: LiveOwnershipStore;
  resources: {
    revoke(run: LiveRun): Promise<void>;
    settle(run: LiveRun): Promise<void>;
    /** Canonical status/resume/complete plus source postconditions, never replay ambiguous work. */
    reconcileJournal(run: LiveRun): Promise<void>;
    /** Reconcile owned routes after reload/partial removal while access remains revoked. */
    reconcileRoutes(run: LiveRun): Promise<void>;
    /** Actual all-process isolation, tree quiescence, helper and current auth/target proof. */
    verify(run: LiveRun): Promise<void>;
    authorize(run: LiveRun): Promise<void>;
    expose(run: LiveRun): Promise<void>;
  };
};

/** Resume retains exclusive ownership. Regrant follows journal/source/route reconciliation.
 * A stopped generation is never resumed: Start must acquire a new claim instead.
 */
export async function resumeLive(deps: LiveResumeDependencies, fence: LiveFence): Promise<LiveRun> {
  let run = deps.owners.assert(fence);
  if (run.state !== 'recoveryRequired' && run.state !== 'error')
    throw new Error('LIVE_STATE_CONFLICT');
  run = deps.owners.mutate(run, { event: 'stop' });
  try {
    for (const name of [
      'revoke',
      'settle',
      'reconcileJournal',
      'reconcileRoutes',
      'verify',
    ] as const) {
      run = deps.owners.mutate(run, { event: 'phase', phase: `resume:${name}:intent` });
      await deps.resources[name](run);
      deps.owners.assert(run);
      run = deps.owners.mutate(run, { event: 'phase', phase: `resume:${name}:ack` });
    }
    run = deps.owners.mutate(run, { event: 'resume' });
    for (const name of ['authorize', 'verify', 'expose'] as const) {
      const phase = name === 'expose' ? 'route' : `resume:${name}`;
      run = deps.owners.mutate(run, { event: 'phase', phase: `${phase}:intent` });
      await deps.resources[name](run);
      deps.owners.assert(run);
      run = deps.owners.mutate(run, { event: 'phase', phase: `${phase}:ack` });
    }
    return deps.owners.mutate(run, { event: 'ready' });
  } catch (error) {
    // Revocation is attempted even if authorization/route activation partially succeeded.
    deps.owners.assert(run);
    try {
      await deps.resources.revoke(run);
    } finally {
      deps.owners.assert(run);
      deps.owners.mutate(run, { event: 'recover', code: 'LIVE_RESUME_RECOVERY_REQUIRED' });
    }
    throw error;
  }
}
