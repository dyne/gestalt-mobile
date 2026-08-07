/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import type { PlanStatusUpdate } from '../../features/plans/application/ports.js';
import { PLAN_MEASUREMENT_REFRESH_MS, PlanMeasurementRefresh } from './plan-measurement-refresh.js';

const active = (stepId = 'l2', planPath = '/work/plan.org'): PlanStatusUpdate => ({
  kind: 'updated',
  identity: planPath,
  planPath,
  reason: null,
  plan: {
    title: 'Plan',
    steps: [
      {
        id: 'l1',
        title: 'L1',
        level: 1,
        state: 'WIP',
        priority: 'A',
        description: {},
        children: [
          {
            id: 'l2',
            title: 'L2',
            level: 2,
            state: 'WIP',
            priority: 'A',
            description: {},
            children: [],
          },
        ],
      },
    ],
    totalSteps: 2,
    doneSteps: 0,
    allDone: false,
    currentStepId: stepId,
  },
});

describe('PlanMeasurementRefresh', () => {
  it('refreshes once per interval and never overlaps an unresolved checkpoint', async () => {
    vi.useFakeTimers();
    let resolveCheckpoint: (() => void) | undefined;
    const checkpoints: string[] = [];
    const refresh = new PlanMeasurementRefresh(
      async () => ({
        capturedAt: '2026-08-02T10:00:00Z',
        weeklyRemainingPercent: 80,
        threadTokens: 10,
      }),
      async (_path, step) => {
        checkpoints.push(step);
        await new Promise<void>((resolve) => {
          resolveCheckpoint = resolve;
        });
      },
    );
    refresh.accept('one', active());
    await vi.advanceTimersByTimeAsync(PLAN_MEASUREMENT_REFRESH_MS * 3);
    expect(checkpoints).toEqual(['l2']);
    resolveCheckpoint?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(PLAN_MEASUREMENT_REFRESH_MS);
    expect(checkpoints).toEqual(['l2', 'l2']);
    refresh.stopAll();
    vi.useRealTimers();
  });

  it('replaces a plan timer, stops on completion, and isolates sessions', async () => {
    vi.useFakeTimers();
    const checkpoints: Array<[string, string]> = [];
    const refresh = new PlanMeasurementRefresh(
      async (sessionId) => ({
        capturedAt: sessionId,
        weeklyRemainingPercent: null,
        threadTokens: null,
      }),
      async (path, step) => {
        checkpoints.push([path, step]);
      },
    );
    refresh.accept('one', active('l2', '/work/first.org'));
    refresh.accept('two', active('l2', '/work/two.org'));
    refresh.accept('one', active('l2', '/work/replacement.org'));
    refresh.accept('two', { kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(PLAN_MEASUREMENT_REFRESH_MS);
    expect(checkpoints).toEqual([['/work/replacement.org', 'l2']]);
    refresh.stopAll();
    vi.useRealTimers();
  });

  it('refreshes immediately on demand and restarts its cadence', async () => {
    vi.useFakeTimers();
    const checkpoints: string[] = [];
    const refresh = new PlanMeasurementRefresh(
      async () => ({ capturedAt: 'now', weeklyRemainingPercent: 80, threadTokens: 10 }),
      async (_path, step) => {
        checkpoints.push(step);
      },
    );
    refresh.accept('one', active());
    refresh.refreshNow('one');
    await vi.runAllTicks();
    expect(checkpoints).toEqual(['l2']);
    await vi.advanceTimersByTimeAsync(PLAN_MEASUREMENT_REFRESH_MS);
    expect(checkpoints).toEqual(['l2', 'l2']);
    refresh.stopAll();
    vi.useRealTimers();
  });

  it('keeps future refreshes alive when a snapshot or helper call fails', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const refresh = new PlanMeasurementRefresh(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return { capturedAt: 'now', weeklyRemainingPercent: null, threadTokens: null };
      },
      async () => {},
    );
    refresh.accept('one', active());
    await vi.advanceTimersByTimeAsync(PLAN_MEASUREMENT_REFRESH_MS * 2);
    expect(attempts).toBe(2);
    refresh.stopAll();
    vi.useRealTimers();
  });
});
