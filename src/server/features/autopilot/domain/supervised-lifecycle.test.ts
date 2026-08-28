/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import {
  classifyExecutorOutcome,
  decideSupervisedLifecycle,
  executorIdentity,
  type ExecutorLifecycle,
  type SupervisedLifecycleInput,
} from './supervised-lifecycle.js';

const now = '2026-08-28T12:00:00.000Z';
const incompletePlan = (l1State: 'TODO' | 'WIP' | 'DONE' = 'WIP'): SupervisedPlan => ({
  title: 'Circuit construction',
  steps: [
    {
      id: 'l4',
      title: 'Construct circuit',
      level: 1,
      state: l1State,
      priority: 'A',
      reviewStatus: 'UNREVIEWED',
      description: {},
      children: [
        {
          id: 'l4-1',
          title: 'Build constraints',
          level: 2,
          state: l1State === 'DONE' ? 'DONE' : 'WIP',
          priority: 'A',
          description: {},
          children: [],
        },
      ],
    },
  ],
  totalSteps: 2,
  doneSteps: l1State === 'DONE' ? 2 : 0,
  allDone: l1State === 'DONE',
  executionComplete: false,
  currentStepId: 'l4',
});
const completePlan = (): SupervisedPlan => ({
  ...incompletePlan('DONE'),
  executionComplete: true,
  steps: [{ ...incompletePlan('DONE').steps[0]!, reviewStatus: 'REVIEWED' }],
});
const executor = (change: Partial<ExecutorLifecycle> = {}): ExecutorLifecycle => ({
  canonicalPosition: 'L4',
  canonicalTaskName: 'l4',
  taskPath: '/root/l4',
  threadId: 'thread-l4',
  l1State: 'WIP',
  l2State: 'WIP',
  lastActivityAt: now,
  ownedProcesses: [],
  outcome: 'partial',
  continuationGeneration: 1,
  continuationCount: 0,
  ...change,
});
const input = (change: Partial<SupervisedLifecycleInput> = {}): SupervisedLifecycleInput => ({
  plan: incompletePlan(),
  event: 'executorTurnEnded',
  executor: executor(),
  now,
  policy: {
    continuationBaseDelayMs: 250,
    continuationMaxDelayMs: 4_000,
    processPollMs: 1_000,
    processMaxElapsedMs: 60_000,
    processMaxRssBytes: 12 * 1024 * 1024 * 1024,
  },
  ...change,
});

describe('supervised Org Plan lifecycle', () => {
  it('treats an incomplete FINAL_ANSWER as partial and rejects the root final', () => {
    expect(
      classifyExecutorOutcome({
        objectiveComplete: false,
        reportedOutcome: 'blocked',
        finalText: 'L4 remains incomplete',
      }),
    ).toEqual({ outcome: 'partial' });
    expect(decideSupervisedLifecycle(input({ event: 'rootFinalAttempt' }))).toMatchObject({
      finalAllowed: false,
      action: { kind: 'resumeExecutor', threadId: 'thread-l4', generation: 2 },
    });
  });

  it('continues the same executor after one L2 completes while L1 remains WIP', () => {
    expect(
      decideSupervisedLifecycle(
        input({ event: 'checkpoint', executor: executor({ l2State: 'DONE' }) }),
      ),
    ).toMatchObject({
      finalAllowed: false,
      action: { kind: 'resumeExecutor', threadId: 'thread-l4' },
    });
  });

  it('reinspects unchanged WIP state after wait timeout instead of yielding', () => {
    expect(decideSupervisedLifecycle(input({ event: 'waitTimeout', executor: undefined }))).toEqual(
      {
        finalAllowed: false,
        action: { kind: 'reinspect' },
      },
    );
  });

  it('transfers a live child process to supervisor monitoring when the executor turn ends', () => {
    const decision = decideSupervisedLifecycle(
      input({
        executor: executor({
          ownedProcesses: [
            {
              processId: 'process-1',
              itemId: 'item-1',
              ownerThreadId: 'thread-l4',
              ownerTaskPath: '/root/l4',
              ownership: 'executor',
              state: 'running',
              observedAt: now,
              elapsedMs: 5_000,
              cpuPercent: 100,
              rssBytes: 2_000_000,
            },
          ],
        }),
      }),
    );
    expect(decision).toMatchObject({
      finalAllowed: false,
      action: {
        kind: 'monitorProcess',
        process: { processId: 'process-1', ownership: 'supervisor', state: 'detached-active' },
      },
    });
  });

  it('consumes an exited process result before resuming its executor', () => {
    expect(
      decideSupervisedLifecycle(
        input({
          event: 'processExited',
          executor: executor({
            ownedProcesses: [
              {
                processId: 'process-1',
                itemId: 'item-1',
                ownerThreadId: 'thread-l4',
                ownerTaskPath: '/root/l4',
                ownership: 'supervisor',
                state: 'exited-awaiting-result',
                observedAt: now,
                elapsedMs: 7_000,
                cpuPercent: 0,
                rssBytes: 0,
                exitStatus: 0,
                resultArtifact: 'thread-l4:item-1',
              },
            ],
          }),
        }),
      ),
    ).toMatchObject({
      finalAllowed: false,
      action: {
        kind: 'consumeProcessResult',
        processId: 'process-1',
        resultArtifact: 'thread-l4:item-1',
      },
    });
  });

  it('terminates only the over-budget detached process and continues diagnosis', () => {
    expect(
      decideSupervisedLifecycle(
        input({
          executor: executor({
            ownedProcesses: [
              {
                processId: 'process-large',
                itemId: 'item-large',
                ownerThreadId: 'thread-l4',
                ownerTaskPath: '/root/l4',
                ownership: 'supervisor',
                state: 'detached-active',
                observedAt: now,
                elapsedMs: 61_000,
                cpuPercent: 100,
                rssBytes: 13 * 1024 * 1024 * 1024,
              },
            ],
          }),
        }),
      ),
    ).toMatchObject({
      finalAllowed: false,
      action: { kind: 'terminateProcess', threadId: 'thread-l4', processId: 'process-large' },
    });
  });

  it('answers status without cancelling the next supervision action', () => {
    expect(decideSupervisedLifecycle(input({ event: 'userStatusAnswered' }))).toMatchObject({
      finalAllowed: false,
      action: { kind: 'resumeExecutor', threadId: 'thread-l4' },
    });
  });

  it.each([
    ['permissionRequired', 'permissionGranted'],
    ['materialAmbiguity', 'userGuidance'],
  ] as const)('allows yielding only for structured %s attention', (reason, resumeCondition) => {
    expect(decideSupervisedLifecycle(input({ attention: { reason, resumeCondition } }))).toEqual({
      finalAllowed: true,
      action: { kind: 'invokeAttention', reason, resumeCondition },
    });
  });

  it('allows final response after every milestone is reviewed', () => {
    expect(decideSupervisedLifecycle(input({ plan: completePlan() }))).toEqual({
      finalAllowed: true,
      action: { kind: 'allowFinal' },
    });
  });

  it('allocates a fresh physical generation while retaining canonical L4 identity', () => {
    expect(executorIdentity('l4', 1)).toEqual({
      canonicalTaskName: 'l4',
      canonicalPosition: 'L4',
      generation: 1,
      taskName: 'l4',
    });
    expect(executorIdentity('l4', 2)).toEqual({
      canonicalTaskName: 'l4',
      canonicalPosition: 'L4',
      generation: 2,
      taskName: 'l4_g2',
    });
  });

  it('bounds partial-loop frequency without converting partial work into a blocker', () => {
    const delays = [0, 1, 2, 20].map(
      (continuationCount) =>
        decideSupervisedLifecycle(input({ executor: executor({ continuationCount }) })).action,
    );
    expect(delays).toEqual([
      expect.objectContaining({ kind: 'resumeExecutor', delayMs: 250 }),
      expect.objectContaining({ kind: 'resumeExecutor', delayMs: 500 }),
      expect.objectContaining({ kind: 'resumeExecutor', delayMs: 1_000 }),
      expect.objectContaining({ kind: 'resumeExecutor', delayMs: 4_000 }),
    ]);
  });
});
