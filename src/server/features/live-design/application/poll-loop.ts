/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LiveFence, LiveOwnershipStore, LiveRun } from './ownership.js';
import type { PollLiveEvents } from './poll-events.js';
import type { PreviewRevocationBarrier } from './ports.js';

/** One loop per admitted helper generation. Construction grants no Start/admission authority. */
export class LivePollLoop {
  private started = false;
  private draining: Promise<void> | null = null;
  constructor(
    private readonly input: {
      owners: LiveOwnershipStore;
      poll: Pick<PollLiveEvents, 'next' | 'settle'>;
      revocations: PreviewRevocationBarrier;
    },
  ) {}
  /** Recovery is visible before its physical revocation/settlement completes.
   * A lifecycle command must join that work before advancing its exact fence.
   * A failed attempt may be retried by the command's own revoke/settle steps.
   */
  async waitForRecoveryDrain(fence: LiveFence): Promise<void> {
    const run = this.input.owners.assert(fence);
    if (run.state !== 'recoveryRequired' && run.state !== 'error') return;
    const pending = this.draining;
    if (pending) await pending.catch(() => {});
    this.input.owners.assert(fence);
  }
  /** Regrant must use a strictly newer generation; old cookies and delayed grants stay denied. */
  async revoke(run: LiveRun): Promise<void> {
    this.input.owners.assert(run);
    await this.input.revocations.revoke({
      liveId: run.liveId,
      throughGeneration: run.generation,
    });
    this.input.owners.assert(run);
  }
  /** Bind to Stop/Resume settlement. Revoke before cancellation, even on stream-close failure. */
  drain(fence: LiveFence): Promise<void> {
    const run = this.input.owners.assert(fence);
    if (run.state !== 'stopping' && run.state !== 'recoveryRequired')
      return Promise.reject(new Error('LIVE_STATE_CONFLICT'));
    if (this.draining) return Promise.reject(new Error('LIVE_SETTLEMENT_REQUIRED'));
    const drain = (async () => {
      let revocationFailed = false;
      let revocationError: unknown;
      try {
        await this.revoke(run);
      } catch (error) {
        revocationFailed = true;
        revocationError = error;
      }
      this.input.owners.assert(fence);
      await this.input.poll.settle(fence);
      this.input.owners.assert(fence);
      if (revocationFailed) throw revocationError;
    })();
    this.draining = drain;
    void drain.finally(() => (this.draining = null)).catch(() => {});
    return drain;
  }
  async run(fence: LiveFence): Promise<'exit' | 'stopped'> {
    if (this.started) throw new Error('LIVE_POLL_RESTART_REQUIRES_RECONCILIATION');
    const initial = this.input.owners.assert(fence);
    if (initial.state !== 'active') throw new Error('LIVE_STATE_CONFLICT');
    this.started = true;
    let recoveryDrainStarted = false;
    try {
      for (;;) {
        const result = await this.input.poll.next(fence);
        if (result === 'exit') {
          recoveryDrainStarted = true;
          await this.drain(this.recovery(fence));
          return 'exit';
        }
        // A canonical timeout waits upstream; yield between iterations too, so an
        // immediate timeout response cannot starve manual Stop or revocation.
        if (result === 'timeout') await new Promise((resolve) => setTimeout(resolve, 25));
        this.input.owners.assert(fence);
      }
    } catch (error) {
      if (recoveryDrainStarted) throw error;
      const current = this.input.owners.current(fence.liveId);
      // Stop owns its new phase/fence and settlement. Never race that cleanup.
      if (
        current?.controllerEpoch === fence.controllerEpoch &&
        current.generation === fence.generation &&
        (current.state === 'stopping' || current.state === 'idle')
      )
        return 'stopped';
      let recovery: LiveRun;
      if (
        current?.revision === fence.revision &&
        current.controllerEpoch === fence.controllerEpoch &&
        current.generation === fence.generation &&
        current.state === 'active'
      )
        recovery = this.input.owners.mutate(fence, {
          event: 'recover',
          code: 'LIVE_POLL_RECOVERY_REQUIRED',
        });
      else recovery = this.recovery(fence);
      // Poll records its own ambiguous outcome; the loop adds physical revocation
      // and drainage, never another poll, source replay or ownership release.
      await this.drain(recovery);
      throw error;
    }
  }
  private recovery(fence: LiveFence): LiveRun {
    const current = this.input.owners.current(fence.liveId);
    if (
      !current ||
      current.controllerEpoch !== fence.controllerEpoch ||
      current.revision !== fence.revision + 1 ||
      current.state !== 'recoveryRequired' ||
      current.generation <= fence.generation
    )
      throw new Error('LIVE_GENERATION_STALE');
    return this.input.owners.assert(current);
  }
}
