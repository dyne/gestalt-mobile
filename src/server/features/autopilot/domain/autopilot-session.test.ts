/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { autopilotSnapshot, disabledAutopilot } from './autopilot-session.js';

describe('autopilotSnapshot controller health', () => {
  it('does not call enabled intent healthy without a continuation', () => {
    const snapshot = autopilotSnapshot(
      {
        ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
        state: 'monitoring',
        requestedEnabled: true,
        stopReason: null,
      },
      3,
    );
    expect(snapshot).toMatchObject({
      enabled: true,
      health: { healthy: false, phase: 'degraded', degradationReason: 'planMismatch' },
    });
  });

  it('exposes only safe parked-wait evidence and considers it healthy', () => {
    const snapshot = autopilotSnapshot(
      {
        ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
        state: 'monitoring',
        requestedEnabled: true,
        stopReason: null,
        supervision: {
          outcome: 'parked',
          progressKey: 'opaque',
          unchangedContinuations: 0,
          probeKey: 'opaque',
          lastReportId: 'report',
          retryKey: null,
          safetyPauseReason: null,
          waitLease: {
            id: 'private',
            probeKey: 'opaque',
            wakeConditions: ['agentActivityChanged', 'processExited'],
          },
        },
      },
      3,
      {
        activeTurn: false,
        executorActive: false,
        control: 'none',
        timerArmed: false,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: true,
        transitionFresh: true,
        observedAt: '2026-09-13T12:00:00.000Z',
      },
    );
    expect(snapshot.health).toEqual(
      expect.objectContaining({
        healthy: true,
        phase: 'waitingForAgentEvent',
        wait: { present: true, wakeCategories: ['agentActivityChanged', 'processExited'] },
      }),
    );
    expect(JSON.stringify(snapshot.health)).not.toContain('private');
  });

  it('never treats an issued historical control as a live root turn', () => {
    const snapshot = autopilotSnapshot(
      {
        ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
        state: 'monitoring',
        requestedEnabled: true,
        stopReason: null,
      },
      3,
      {
        activeTurn: false,
        executorActive: false,
        control: 'issued',
        timerArmed: false,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: false,
        transitionFresh: true,
        observedAt: '2026-09-13T12:00:01.000Z',
      },
    );
    expect(snapshot.health).toMatchObject({ healthy: false, phase: 'degraded' });
  });

  it('fails closed for an overdue schedule or a mismatched retained plan', () => {
    const state = {
      ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
      state: 'backoff' as const,
      requestedEnabled: true,
      stopReason: null,
      nextEvaluationAt: '2026-09-13T11:59:59.000Z',
    };
    expect(
      autopilotSnapshot(state, 3, {
        activeTurn: false,
        executorActive: false,
        control: 'scheduled',
        timerArmed: true,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: false,
        transitionFresh: true,
        observedAt: '2026-09-13T12:00:00.000Z',
      }).health,
    ).toMatchObject({ healthy: false, degradationReason: 'staleTransition' });
    expect(
      autopilotSnapshot(state, 3, {
        activeTurn: false,
        executorActive: false,
        control: 'scheduled',
        timerArmed: true,
        reconciling: false,
        planMatches: false,
        parkedSubscriptionActive: false,
        transitionFresh: true,
        observedAt: '2026-09-13T11:59:00.000Z',
      }).health,
    ).toMatchObject({ healthy: false, degradationReason: 'planMismatch' });
  });

  it('does not let malformed or duplicate wake categories become health evidence', () => {
    const snapshot = autopilotSnapshot(
      {
        ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
        state: 'monitoring',
        requestedEnabled: true,
        stopReason: null,
        supervision: {
          outcome: 'parked',
          progressKey: 'opaque',
          unchangedContinuations: 0,
          probeKey: 'opaque',
          lastReportId: 'report',
          retryKey: null,
          safetyPauseReason: null,
          waitLease: {
            id: 'private',
            probeKey: 'opaque',
            wakeConditions: ['agentActivityChanged', 'agentActivityChanged'],
          },
        },
      },
      3,
      {
        activeTurn: false,
        executorActive: false,
        control: 'none',
        timerArmed: false,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: true,
        transitionFresh: true,
        observedAt: '2026-09-13T12:00:00.000Z',
      },
    );
    expect(snapshot.health).toMatchObject({
      healthy: false,
      degradationReason: 'invalidWaitLease',
    });
    expect(snapshot.health.wait.wakeCategories).toEqual([]);
  });

  it.each(['active child', 'owned process'] as const)(
    'keeps a fresh %s as healthy executor evidence without inventing a lease',
    () => {
      const snapshot = autopilotSnapshot(
        {
          ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
          state: 'monitoring',
          requestedEnabled: true,
          stopReason: null,
        },
        3,
        {
          activeTurn: false,
          executorActive: true,
          control: 'none',
          timerArmed: false,
          reconciling: false,
          planMatches: true,
          parkedSubscriptionActive: false,
          transitionFresh: false,
          observedAt: '2026-09-13T12:10:00.000Z',
        },
      );
      expect(snapshot.health).toMatchObject({ healthy: true, phase: 'waitingForAgentEvent' });
      expect(snapshot.health.wait).toEqual({ present: false, wakeCategories: [] });
    },
  );

  it('does not count stale executor evidence', () => {
    const snapshot = autopilotSnapshot(
      {
        ...disabledAutopilot('s', '2026-09-13T12:00:00.000Z'),
        state: 'monitoring',
        requestedEnabled: true,
        stopReason: null,
      },
      3,
      {
        activeTurn: false,
        executorActive: false,
        control: 'none',
        timerArmed: false,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: false,
        transitionFresh: false,
        observedAt: '2026-09-13T12:10:00.000Z',
      },
    );
    expect(snapshot.health).toMatchObject({ healthy: false, phase: 'degraded' });
  });
});
