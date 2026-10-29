/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { SessionProviderRecovery } from './provider-recovery.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const state: { session: RelaySessionSnapshot | null; authority: string | null } = {
    session: {
      id: 's',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      provider: 'codex',
      threadId: 'root',
      state: 'ready',
      desiredState: 'active',
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 't',
      updatedAt: 'failed-1',
    },
    authority: 'manual-0',
  };
  const reconcile = vi.fn(async () => true);
  const starts = vi.fn(async (_session: RelaySessionSnapshot, current: () => boolean) => {
    if (!current()) throw new Error('cancelled');
    state.session = {
      ...state.session!,
      state: 'turnActive',
      activeTurnId: 'retry-turn',
      updatedAt: 'started',
    };
  });
  const publish = vi.fn();
  const callbacks: Array<() => void> = [];
  const recovery = new SessionProviderRecovery({
    find: () => state.session,
    authority: () => state.authority,
    reconcile,
    start: starts,
    publish,
    schedule: (callback, delay) => {
      callbacks.push(callback);
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  const fail = (turnId = 'failed-turn', code = 'serverOverloaded') =>
    recovery.failed(state.session!, turnId, { code });
  return { state, recovery, starts, reconcile, publish, callbacks, fail };
}

describe('ordinary session provider recovery', () => {
  it.each(['serverOverloaded', 'rateLimitExceeded'])(
    'waits one minute and retries %s exactly once',
    async (code) => {
      const f = fixture();
      f.fail('failed-turn', code);
      f.fail('failed-turn', code);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.starts).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.starts).toHaveBeenCalledOnce();
      f.callbacks[0]!();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.publish).toHaveBeenCalledWith('s', 'session.provider-retry-started', {
        turnId: 'failed-turn',
        retryAttempt: 1,
      });
    },
  );

  it.each([
    'usageLimitExceeded',
    'sessionBudgetExceeded',
    'contextWindowExceeded',
    'unauthorized',
    'misalignmentPolicyViolation',
    'other',
  ])('never automatically retries %s', async (code) => {
    const f = fixture();
    f.fail('failed-turn', code);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.callbacks).toHaveLength(0);
  });

  it.each(['manualSend', 'interrupt', 'release', 'successfulTurn', 'shutdown'])(
    'cancels retry on %s, including an already queued callback',
    async (action) => {
      const f = fixture();
      f.fail();
      if (action === 'shutdown') f.recovery.dispose();
      else f.recovery.cancel('s');
      f.callbacks[0]!();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.starts).not.toHaveBeenCalled();
    },
  );

  it.each([
    'changedSession',
    'activeTurn',
    'changedThread',
    'stopped',
    'removed',
    'approvalOrAutopilot',
    'authorityChanged',
  ])('does not resume after %s', async (change) => {
    const f = fixture();
    f.fail();
    if (change === 'removed') f.state.session = null;
    else if (change === 'approvalOrAutopilot') f.state.authority = null;
    else if (change === 'authorityChanged') f.state.authority = 'manual-2';
    else if (change === 'changedSession') f.state.session!.updatedAt = 'newer';
    else if (change === 'activeTurn') f.state.session!.activeTurnId = 'new-turn';
    else if (change === 'changedThread') f.state.session!.threadId = 'replacement';
    else f.state.session!.desiredState = 'stopped';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('requires reconciled idle activity and fails closed on read failure', async () => {
    const f = fixture();
    f.reconcile.mockResolvedValueOnce(false);
    f.fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith('s', 'session.provider-retry-abandoned', {
      turnId: 'failed-turn',
      retryAttempt: 1,
      reason: 'activityNotIdle',
    });
  });

  it('rechecks cancellation after asynchronous reconciliation', async () => {
    const f = fixture();
    let release!: (value: boolean) => void;
    f.reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.fail();
    await vi.advanceTimersByTimeAsync(60_000);
    f.recovery.cancel('s');
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('caps a consecutive failure episode at two attempts and resets on a manual send', async () => {
    const f = fixture();
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.state.session = {
        ...f.state.session!,
        state: 'ready',
        activeTurnId: null,
        updatedAt: `failed-${attempt}`,
      };
      f.fail(`turn-${attempt}`);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(f.starts).toHaveBeenCalledTimes(2);
    f.recovery.cancel('s');
    f.fail('new-task');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.starts).toHaveBeenCalledTimes(3);
  });

  it('does not replay an unconfirmed turn acceptance', async () => {
    const f = fixture();
    f.starts.mockRejectedValueOnce(new Error('private provider transport detail'));
    f.fail();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.starts).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain('private provider');
  });
});
