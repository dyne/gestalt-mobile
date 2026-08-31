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
  AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT,
  AUTOPILOT_PROMPT_VERSION,
  autopilotExecutorLaunchPrompt,
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
  it('reserves a terminal-review continuation after a checkpointed final L1', () => {
    const state = {
      ...disabledAutopilot('s', now),
      state: 'monitoring' as const,
      requestedEnabled: true,
      checkpoints: {
        protocolVersion: 1 as const,
        planIdentity: 'plan',
        reportedL1Ids: ['l1'],
        acceptedKeys: ['accepted'],
        pendingTurnId: null,
        terminalReviewAccepted: false,
      },
    };
    expect(
      decideAutopilot({
        state,
        plan: plan('REVIEWED'),
        activity: createAgentActivitySnapshot('s', now),
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toMatchObject({ kind: 'scheduleContinuation' });
    expect(
      decideAutopilot({
        state: { ...state, checkpoints: { ...state.checkpoints, terminalReviewAccepted: true } },
        plan: plan('REVIEWED'),
        activity: createAgentActivitySnapshot('s', now),
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'complete' });
  });
  it('does not schedule when sensors are stale or an ordinary interaction is pending', () => {
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
    ).toEqual({ kind: 'observe' });
  });
  it('keeps the only continuation prompt versioned and deterministic', () => {
    expect(AUTOPILOT_PROMPT_VERSION).toBe('v5');
    expect(AUTOPILOT_CONTINUATION_PROMPT).toContain(
      'Refer to every L1 as L<a> and each nested L2 as L<a>.<b>',
    );
    expect(AUTOPILOT_CONTINUATION_PROMPT).toContain('task_name l<a> or l<a>_<b>');
    expect(AUTOPILOT_CONTINUATION_PROMPT).toContain('Do not send a status-only response.');
    expect(AUTOPILOT_CONTINUATION_PROMPT).toContain('gestalt_autopilot_wait_lease');
    expect(AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT).toContain('prior turn ending did not complete');
  });
  it('uses a fresh physical task and explicit model handoff for a replacement executor', () => {
    const prompt = autopilotExecutorLaunchPrompt({
      canonicalTaskName: 'l7',
      canonicalPosition: 'L7',
      generation: 2,
      taskName: 'l7_g2',
    });
    expect(prompt).toContain('Launch task_name l7_g2 for canonical L7');
    expect(prompt).toContain('the durable l7 slot may remain reserved');
    expect(prompt).toContain(
      "Do not reuse that task_name or attempt to change an existing agent's model in place",
    );
    expect(prompt).toContain(
      'spawn l7_g2 with agent_type worker and an explicit model selected by the supervisor',
    );
    expect(prompt).toContain('Transfer sole L7 ownership');
  });
  it('keeps the canonical task name for the first executor generation', () => {
    const prompt = autopilotExecutorLaunchPrompt({
      canonicalTaskName: 'l7',
      canonicalPosition: 'L7',
      generation: 1,
      taskName: 'l7',
    });
    expect(prompt).toContain('Launch task_name l7 for canonical L7');
    expect(prompt).not.toContain('replacement generation');
  });
  type ActivityChange = Partial<
    Pick<AgentActivitySnapshot, 'confidence' | 'aggregateSubagents'>
  > & { root?: Pick<AgentActivitySnapshot['root'], 'state'> };
  it.each([
    ['active root', { root: { state: 'working' } }, false, 'observe'],
    [
      'solo root awaiting a settled child',
      { root: { state: 'awaitingAgent' } },
      false,
      'scheduleContinuation',
    ],
    [
      'root awaiting an active child',
      { root: { state: 'awaitingAgent' }, aggregateSubagents: 'working' },
      false,
      'observe',
    ],
    [
      'root awaiting settled blocked children',
      { root: { state: 'awaitingAgent' }, aggregateSubagents: 'blocked' },
      false,
      'scheduleContinuation',
    ],
    ['awaiting child', { aggregateSubagents: 'awaitingAgent' }, false, 'observe'],
    ['working child', { aggregateSubagents: 'working' }, false, 'observe'],
    ['root awaiting human', { root: { state: 'awaitingHuman' } }, false, 'observe'],
    ['child awaiting human', { aggregateSubagents: 'awaitingHuman' }, false, 'observe'],
    ['pending interaction', {}, true, 'observe'],
    ['typed attention', {}, false, 'requestAttention'],
    ['stale sensor', { confidence: 'stale' }, false, 'reconcile'],
    ['healthy idle', {}, false, 'scheduleContinuation'],
    ['blocked root', { root: { state: 'blocked' } }, false, 'scheduleContinuation'],
    ['blocked child', { aggregateSubagents: 'blocked' }, false, 'scheduleContinuation'],
    ['disconnected root', { root: { state: 'disconnected' } }, false, 'reconcile'],
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
  it('names terminal and manual-disable decisions while partial loops remain scheduled', () => {
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
    ).toEqual({ kind: 'scheduleContinuation', at: '2026-08-20T12:00:08.000Z' });
    expect(
      decideAutopilot({
        state: enabled,
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        automaticActionCount: defaultAutopilotPolicy.actionLimit,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'scheduleContinuation', at: '2026-08-20T12:00:01.000Z' });
    expect(
      decideAutopilot({
        state: enabled,
        plan: incomplete,
        activity: { ...active, root: { ...active.root, state: 'working' } },
        hasPendingInteraction: false,
        automaticActionCount: defaultAutopilotPolicy.actionLimit,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'observe' });
    expect(
      decideAutopilot({
        state: {
          ...enabled,
          state: 'attentionRequired',
          requestedEnabled: false,
          stopReason: 'attentionRequired',
        },
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        hasActiveAttention: true,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'requestAttention', reason: 'attentionRequired' });
    expect(
      decideAutopilot({
        state: {
          ...enabled,
          state: 'attentionRequired',
          requestedEnabled: false,
          stopReason: 'startUnavailable',
        },
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        hasActiveAttention: true,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'requestAttention', reason: 'startUnavailable' });
  });

  it('pauses only after the bounded automatic-action cap is exceeded', () => {
    const active = {
      ...createAgentActivitySnapshot('s', now),
      confidence: 'fresh' as const,
      root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' as const },
      aggregateSubagents: 'idle' as const,
    };
    const state = {
      ...disabledAutopilot('s', now),
      state: 'monitoring' as const,
      requestedEnabled: true,
    };
    const incomplete = {
      ...plan(),
      executionComplete: false,
      allDone: false,
      steps: [{ ...plan().steps[0]!, state: 'WIP' as const }],
    };
    expect(
      decideAutopilot({
        state,
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        automaticActionCount: defaultAutopilotPolicy.actionLimit,
        now,
        policy: defaultAutopilotPolicy,
      }).kind,
    ).toBe('scheduleContinuation');
    expect(
      decideAutopilot({
        state,
        plan: incomplete,
        activity: active,
        hasPendingInteraction: false,
        automaticActionCount: defaultAutopilotPolicy.actionLimit + 1,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'safetyPause', reason: 'actionRateExceeded' });
  });
});
