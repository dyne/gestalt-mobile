/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { disabledAutopilot } from '../domain/autopilot-session.js';
import {
  AUTOPILOT_CONTINUATION_PROMPT,
  AUTOPILOT_PROMPT_VERSION,
  decideAutopilot,
  defaultAutopilotPolicy,
  executionComplete,
} from './policy.js';

const now = '2026-08-20T12:00:00.000Z';
const plan = (reviewStatus: 'REVIEWED' | 'UNREVIEWED' = 'UNREVIEWED'): SupervisedPlan => ({
  title: 'Plan',
  steps: [
    {
      id: 'l1',
      title: 'L1',
      level: 1,
      state: 'DONE',
      priority: 'A',
      reviewStatus,
      description: {},
      children: [
        {
          id: 'l2',
          title: 'L2',
          level: 2,
          state: 'DONE',
          priority: 'A',
          description: {},
          children: [],
        },
      ],
    },
  ],
  totalSteps: 2,
  doneSteps: 2,
  allDone: true,
  currentStepId: 'l1',
});

describe('autopilot policy', () => {
  it('requires reviewed L1s for execution completion', () => {
    expect(executionComplete(plan())).toBe(false);
    expect(executionComplete(plan('REVIEWED'))).toBe(true);
  });
  it('does not schedule when sensors are stale or human attention is pending', () => {
    const state = {
      ...disabledAutopilot('s', now),
      state: 'monitoring' as const,
      requestedEnabled: true,
    };
    expect(
      decideAutopilot({
        state,
        plan: {
          ...plan(),
          allDone: false,
          steps: [{ ...plan().steps[0]!, state: 'WIP', reviewStatus: 'UNREVIEWED' }],
        },
        activity: createAgentActivitySnapshot('s', now),
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'reconcile' });
    expect(
      decideAutopilot({
        state,
        plan: {
          ...plan(),
          allDone: false,
          steps: [{ ...plan().steps[0]!, state: 'WIP', reviewStatus: 'UNREVIEWED' }],
        },
        activity: null,
        hasPendingInteraction: true,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'requestAttention', reason: 'attentionRequired' });
  });
  it('keeps the only continuation prompt versioned and deterministic', () => {
    expect(AUTOPILOT_PROMPT_VERSION).toBe('v1');
    expect(AUTOPILOT_CONTINUATION_PROMPT).toContain('Do not send a status-only response.');
  });
  type ActivityChange = Partial<
    Pick<AgentActivitySnapshot, 'confidence' | 'aggregateSubagents'>
  > & { root?: Pick<AgentActivitySnapshot['root'], 'state'> };
  it.each([
    ['active root', { root: { state: 'working' } }, false, 'observe'],
    ['awaiting child', { aggregateSubagents: 'awaitingAgent' }, false, 'observe'],
    ['working child', { aggregateSubagents: 'working' }, false, 'observe'],
    ['pending interaction', {}, true, 'requestAttention'],
    ['typed attention', {}, false, 'requestAttention'],
    ['stale sensor', { confidence: 'stale' }, false, 'reconcile'],
    ['healthy idle', {}, false, 'scheduleContinuation'],
    ['blocked root', { root: { state: 'blocked' } }, false, 'scheduleContinuation'],
    ['blocked child', { aggregateSubagents: 'blocked' }, false, 'scheduleContinuation'],
    ['disconnected child', { aggregateSubagents: 'disconnected' }, false, 'reconcile'],
  ] as ReadonlyArray<readonly [string, ActivityChange, boolean, string]>)(
    'decides safely for %s',
    (_name, change, pending, expected) => {
      const base = createAgentActivitySnapshot('s', now);
      const { root: rootChange, ...activityChange } = change;
      const activity: AgentActivitySnapshot = {
        ...base,
        confidence: 'fresh' as const,
        root: { ...base.root, state: 'idle' as const },
        ...activityChange,
        ...(rootChange ? { root: { ...base.root, state: rootChange.state } } : {}),
      };
      const incomplete = {
        ...plan(),
        executionComplete: false,
        allDone: false,
        steps: [{ ...plan().steps[0]!, state: 'WIP' as const }],
      };
      const state = {
        ...disabledAutopilot('s', now),
        state: 'monitoring' as const,
        requestedEnabled: true,
      };
      const result = decideAutopilot({
        state,
        plan: incomplete,
        activity,
        hasPendingInteraction: pending,
        hasActiveAttention: _name === 'typed attention',
        lastTurnOutcome: 'completed',
        now,
        policy: defaultAutopilotPolicy,
      });
      expect(result.kind).toBe(expected);
      expect(
        decideAutopilot({
          state,
          plan: incomplete,
          activity,
          hasPendingInteraction: pending,
          hasActiveAttention: _name === 'typed attention',
          lastTurnOutcome: 'completed',
          now,
          policy: defaultAutopilotPolicy,
        }),
      ).toEqual(result);
    },
  );
  it('names terminal, manual-disable, and bounded-exhaustion decisions', () => {
    const base = createAgentActivitySnapshot('s', now);
    const active: AgentActivitySnapshot = {
      ...base,
      confidence: 'fresh',
      root: { ...base.root, state: 'idle', lastActivityAt: now },
      aggregateSubagents: 'idle',
    };
    const incomplete = {
      ...plan(),
      executionComplete: false,
      allDone: false,
      steps: [{ ...plan().steps[0]!, state: 'WIP' as const }],
    };
    const enabled = {
      ...disabledAutopilot('s', now),
      state: 'monitoring' as const,
      requestedEnabled: true,
    };
    expect(
      decideAutopilot({
        state: { ...enabled, requestedEnabled: false },
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'disable', reason: 'manualDisabled' });
    expect(
      decideAutopilot({
        state: enabled,
        plan: plan('REVIEWED'),
        activity: active,
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'complete' });
    expect(
      decideAutopilot({
        state: { ...enabled, consecutiveNoProgress: defaultAutopilotPolicy.retryLimit },
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        lastTurnOutcome: 'failed',
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'requestAttention', reason: 'noPlanProgress' });
  });
});
