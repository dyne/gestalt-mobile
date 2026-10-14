/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { parseSupervisedPlan } from './parse-supervised-plan.js';
import { currentExecutableL1Index, type SupervisedPlan } from '../domain/supervised-plan.js';
import { parseOrgDocument } from '../../../../client/features/plans/org-document.js';
import { presentPlan } from '../../../../client/features/plans/plan-presentation.js';
import { decideAutopilot, defaultAutopilotPolicy } from '../../autopilot/application/policy.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import { disabledAutopilot } from '../../autopilot/domain/autopilot-session.js';
import {
  decideSupervisedLifecycle,
  parsePersistedSupervisedLifecycle,
  type ExecutorLifecycle,
} from '../../autopilot/domain/supervised-lifecycle.js';
import {
  resolveOrgPlanCheckpointSignal,
  validateOrgPlanCheckpoint,
} from '../../org-plan-checkpoint/application/validate.js';

const now = '2026-10-13T12:00:00Z';
function parent(id: string, state: string, property = '', review = 'UNREVIEWED') {
  return `* ${state} [#A] ${id}
:PROPERTIES:
:ID: ${id}
:SKILLS: $vertical-slice-architecture
:REVIEW_STATUS: ${review}
${property}:END:
- Effort :: Small
- Goal :: Verify suspension
- Notes :: Preserve progress
`;
}
function child(id: string, state: string) {
  return `** ${state} [#A] ${id}
:PROPERTIES:
:ID: ${id}
:END:
- Why :: Dependency repair
- Change :: Preserve state
- Tests :: Focused regression
- Done when :: Verified
`;
}
const source = () => `#+TITLE: Suspension
${parent('dependency', 'WIP')}${child('dependency-child', 'WIP')}${parent('dependent', 'SUSPENDED', ':SUSPENDED_FOR: dependency\n')}${child('completed', 'DONE')}${child('paused', 'SUSPENDED')}${child('untouched', 'TODO')}${parent('later', 'TODO')}`;
const parse = (text: string) =>
  parseSupervisedPlan({
    source: text,
    planPath: '/work/.gestalt/plan.org',
    workspacePath: '/work',
  });
function retained(text = source()): SupervisedPlan {
  const result = parse(text);
  if (result.kind !== 'available') throw new Error(result.reason);
  return result.plan;
}
const owner: ExecutorLifecycle = {
  canonicalPosition: 'L2',
  canonicalTaskName: 'l2',
  taskPath: '/root/l2',
  threadId: 'owning-thread',
  l1State: 'SUSPENDED',
  l2State: 'SUSPENDED',
  lastActivityAt: now,
  ownedProcesses: [],
  outcome: 'partial',
  continuationGeneration: 1,
  continuationCount: 3,
};

describe('suspension-v1 consumer contract', () => {
  it('preserves literal state, sibling progress and client document titles while selecting the reopened dependency', () => {
    const plan = retained();
    expect(plan.currentStepId).toBe('dependency-child');
    expect(currentExecutableL1Index(plan)).toBe(0);
    expect(plan.steps[1]?.children.map((step) => step.state)).toEqual([
      'DONE',
      'SUSPENDED',
      'TODO',
    ]);
    expect(plan.allDone).toBe(false);
    expect(plan.executionComplete).toBe(false);
    expect(parseOrgDocument(source()).sections[2]).toMatchObject({
      title: 'dependent',
      state: 'SUSPENDED',
    });
  });

  it.each([
    (s: string) => s.replace(':SUSPENDED_FOR: dependency\n', ''),
    (s: string) => s.replace(':SUSPENDED_FOR: dependency', ':SUSPENDED_FOR: later'),
    (s: string) =>
      s.replace(
        ':REVIEW_STATUS: UNREVIEWED\n:SUSPENDED_FOR: dependency',
        ':REVIEW_STATUS: REVIEWED\n:SUSPENDED_FOR: dependency',
      ),
    (s: string) => s.replace('** SUSPENDED [#A] paused', '** WIP [#A] paused'),
    (s: string) => s.replace('** TODO [#A] untouched', '** SUSPENDED [#A] untouched'),
    (s: string) => s.replace('* WIP [#A] dependency', '* DONE [#A] dependency'),
    (s: string) => s.replace('* TODO [#A] later', '* WIP [#A] later'),
    (s: string) => s.replace(':ID: completed\n', ':ID: completed\n:SUSPENDED_FOR: dependency\n'),
  ])('rejects malformed suspended ancestry without a partial projection', (change) => {
    expect(parse(change(source())).kind).toBe('unavailable');
  });

  it('selects dependency review, then exposes suspension without skipping to later TODO or dispatching', () => {
    const completed = source()
      .replace('* WIP [#A] dependency', '* DONE [#A] dependency')
      .replace('** WIP [#A] dependency-child', '** DONE [#A] dependency-child');
    expect(retained(completed).currentStepId).toBe('dependency');
    const plan = retained(
      completed.replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: REVIEWED'),
    );
    expect(plan.currentStepId).toBe('dependent');
    expect(currentExecutableL1Index(plan)).toBe(-1);
    expect(presentPlan(plan)).toMatchObject({
      phase: 'suspended',
      current: { state: 'SUSPENDED' },
    });
    expect(
      decideAutopilot({
        state: { ...disabledAutopilot('s', now), requestedEnabled: true },
        plan,
        activity: null,
        hasPendingInteraction: false,
        now,
        policy: defaultAutopilotPolicy,
      }),
    ).toEqual({ kind: 'observe' });
  });

  it('allows only the checkpoint-authorized supervisor handoff and preserves Off, attention and interaction gates', () => {
    const plan = retained(
      source()
        .replace('* WIP [#A] dependency', '* DONE [#A] dependency')
        .replace('** WIP [#A] dependency-child', '** DONE [#A] dependency-child')
        .replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: REVIEWED'),
    );
    const base = createAgentActivitySnapshot('s', now);
    const state = {
      ...disabledAutopilot('s', now),
      requestedEnabled: true,
      checkpoints: {
        protocolVersion: 1 as const,
        planIdentity: 'p',
        reportedL1Ids: ['dependency'],
        reportedL2Ids: [],
        acceptedKeys: [],
        pendingTurnId: null,
        terminalReviewAccepted: false,
        rootContinuationFromTurnId: 'accepted-dependency-turn',
      },
    };
    const input = {
      state,
      plan,
      activity: {
        ...base,
        confidence: 'fresh' as const,
        root: { ...base.root, state: 'idle' as const },
      },
      hasPendingInteraction: false,
      now,
      policy: defaultAutopilotPolicy,
    };
    expect(decideAutopilot(input).kind).toBe('scheduleContinuation');
    expect(decideAutopilot({ ...input, state: { ...state, requestedEnabled: false } })).toEqual({
      kind: 'disable',
      reason: 'manualDisabled',
    });
    expect(decideAutopilot({ ...input, hasPendingInteraction: true })).toEqual({ kind: 'observe' });
    expect(decideAutopilot({ ...input, hasActiveAttention: true }).kind).toBe('requestAttention');
    expect(decideAutopilot({ ...input, state: { ...state, state: 'safetyPaused' } })).toEqual({
      kind: 'observe',
    });
    expect(
      decideAutopilot({
        ...input,
        state: {
          ...state,
          checkpoints: { ...state.checkpoints, rootContinuationFromTurnId: undefined },
        },
      }),
    ).toEqual({ kind: 'observe' });
  });

  it('retains persisted physical ownership and refuses a suspended executor continuation', () => {
    expect(parsePersistedSupervisedLifecycle({ executor: owner })?.executor).toMatchObject(owner);
    expect(
      decideSupervisedLifecycle({
        plan: retained(),
        executor: owner,
        event: 'executorTurnEnded',
        now,
        policy: {
          continuationBaseDelayMs: 1,
          continuationMaxDelayMs: 10,
          processPollMs: 1,
          processMaxElapsedMs: 1000,
          processMaxRssBytes: 1000,
        },
      }).action.kind,
    ).toBe('continueSupervisor');
    const resumed = retained(
      source()
        .replace('* WIP [#A] dependency', '* DONE [#A] dependency')
        .replace('** WIP [#A] dependency-child', '** DONE [#A] dependency-child')
        .replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: REVIEWED')
        .replaceAll('SUSPENDED [#A]', 'WIP [#A]')
        .replace(':SUSPENDED_FOR: dependency\n', ''),
    );
    expect(resumed.currentStepId).toBe('paused');
    expect(currentExecutableL1Index(resumed)).toBe(1);
    expect(
      parsePersistedSupervisedLifecycle({ executor: { ...owner, l1State: 'WIP', l2State: 'WIP' } })
        ?.executor,
    ).toMatchObject({ taskPath: owner.taskPath, threadId: owner.threadId, continuationCount: 3 });
  });

  it('round-trips unissued supersession evidence and rejects an issued command marked unissued', () => {
    const command = {
      commandId: 'c',
      status: 'superseded' as const,
      supersededBeforeIssue: true as const,
      planIdentity: 'p',
      planFingerprint: 'fingerprint',
      canonicalPosition: 'L2',
      canonicalTaskName: 'l2',
      taskPath: owner.taskPath,
      threadId: owner.threadId,
      generation: 2,
      trigger: 'partial' as const,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      parsePersistedSupervisedLifecycle({ executor: { ...owner, commands: [command] } })?.executor
        ?.commands,
    ).toEqual([command]);
    expect(
      parsePersistedSupervisedLifecycle({
        executor: { ...owner, commands: [{ ...command, status: 'issued' }] },
      }),
    ).toBeUndefined();
  });

  it('refuses historical DONE-child checkpoints beneath suspended work', () => {
    const plan = retained();
    expect(
      resolveOrgPlanCheckpointSignal('l2Completed', plan, 'p', 'l2:completed:DONE'),
    ).toBeNull();
    expect(
      validateOrgPlanCheckpoint({
        plan,
        planIdentity: 'p',
        rootOwned: true,
        hasActiveL1Writer: () => false,
        checkpoint: {
          version: 1,
          kind: 'l2Completed',
          planIdentity: 'p',
          l1Id: 'dependent',
          l2Id: 'completed',
          position: 'L2.1',
          status: 'DONE',
          changes: 'historical',
          files: 'none',
          tests: 'historical',
        },
      }),
    ).toMatchObject({ valid: false, reasonCode: 'l1Suspended' });
  });
});
