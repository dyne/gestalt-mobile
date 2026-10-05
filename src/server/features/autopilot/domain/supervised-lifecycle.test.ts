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
  executorAssignment,
  executorIdentity,
  parsePersistedSupervisedLifecycle,
  type ExecutorLifecycle,
  type SupervisedLifecycleInput,
} from './supervised-lifecycle.js';

const now = '2026-08-28T12:00:00.000Z';
describe('optional persisted object shapes', () => {
  it.each([null, 'invalid', 1, false, []])('rejects present malformed objects: %j', (value) => {
    for (const field of ['executor', 'blocking', 'checkpoints', 'supervision'])
      expect(parsePersistedSupervisedLifecycle({ [field]: value })).toBeUndefined();
    for (const field of ['assignment', 'replacement', 'blocking'])
      expect(
        parsePersistedSupervisedLifecycle({ executor: { ...executor(), [field]: value } }),
      ).toBeUndefined();
  });
});
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
  it('migrates a legacy executor row and round-trips one immutable physical assignment', () => {
    const legacy = executor();
    const assignment = executorAssignment(legacy);
    expect(
      parsePersistedSupervisedLifecycle({ executor: legacy })?.executor?.assignment,
    ).toBeUndefined();
    expect(
      parsePersistedSupervisedLifecycle({ executor: { ...legacy, assignment } })?.executor
        ?.assignment,
    ).toEqual(assignment);
  });

  it('repairs a legacy logical turn counter that polluted the physical generation', () => {
    const assigned = executorAssignment(executor());
    expect(
      parsePersistedSupervisedLifecycle({
        executor: {
          ...executor({ continuationGeneration: 4, continuationCount: 3 }),
          assignment: assigned,
        },
      })?.executor,
    ).toMatchObject({
      assignment: assigned,
      continuationGeneration: 1,
      continuationCount: 3,
    });
  });

  it('rejects an assignment whose physical task name is not authorized by its generation', () => {
    const legacy = executor();
    expect(
      parsePersistedSupervisedLifecycle({
        executor: {
          ...legacy,
          assignment: { ...executorAssignment(legacy), taskName: 'l4_g2' },
        },
      }),
    ).toBeUndefined();
  });

  it('rejects a replacement authorization whose task name does not match its exact generation', () => {
    const legacy = executor();
    const replacement = {
      ...executorIdentity('l4', 2),
      planIdentity: 'plan',
      planFingerprint: 'fingerprint',
      previous: { ...executorAssignment(legacy), state: 'unavailable' as const },
      reason: 'explicitExecutorRejection' as const,
      evidence: 'retry-limit-exhausted',
    };
    expect(
      parsePersistedSupervisedLifecycle({ executor: { ...legacy, replacement } })?.executor
        ?.replacement,
    ).toEqual(replacement);
    expect(
      parsePersistedSupervisedLifecycle({
        executor: { ...legacy, replacement: { ...replacement, taskName: 'l4_g3' } },
      }),
    ).toBeUndefined();
  });

  it('loads legacy checkpoints and infers their pending report kind', () => {
    expect(
      parsePersistedSupervisedLifecycle({
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          reportedL1Ids: ['l1'],
          acceptedKeys: ['key'],
          pendingTurnId: 'turn',
          terminalReviewAccepted: false,
        },
      }),
    ).toEqual({
      checkpoints: {
        protocolVersion: 1,
        planIdentity: 'plan',
        completionEpochs: [{ target: '["l1","l1"]', epoch: 0, reopened: false, completed: true }],
        reportedL2Ids: [],
        reportedL1Ids: ['l1'],
        acceptedKeys: ['key'],
        pendingTurnId: 'turn',
        pendingKind: 'l1Accepted',
        terminalReviewAccepted: false,
      },
    });
  });

  it('round-trips reconstructed target-local completion epochs', () => {
    expect(
      parsePersistedSupervisedLifecycle({
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          completionEpochs: [
            { target: '["l1","l1"]', epoch: 1, reopened: false, completed: true },
            { target: '["l2","l1","l2"]', epoch: 2, reopened: true, completed: false },
          ],
          reportedL1Ids: [],
          acceptedKeys: [],
          pendingTurnId: null,
          terminalReviewAccepted: false,
        },
      })?.checkpoints?.completionEpochs,
    ).toEqual([
      { target: '["l1","l1"]', epoch: 1, reopened: false, completed: true },
      { target: '["l2","l1","l2"]', epoch: 2, reopened: true, completed: false },
    ]);
  });

  it('keeps colon-bearing L1 and L2 IDs collision-safe', () => {
    const parsed = parsePersistedSupervisedLifecycle({
      checkpoints: {
        protocolVersion: 1,
        planIdentity: 'plan',
        completionEpochs: [
          {
            target: JSON.stringify(['l2', 'a:b', 'c']),
            epoch: 0,
            reopened: false,
            completed: true,
          },
          {
            target: JSON.stringify(['l2', 'a', 'b:c']),
            epoch: 0,
            reopened: false,
            completed: true,
          },
        ],
        reportedL1Ids: [],
        reportedL2Ids: [],
        acceptedKeys: [],
        pendingTurnId: null,
        terminalReviewAccepted: false,
      },
    });
    expect(parsed?.checkpoints?.completionEpochs).toHaveLength(2);
  });

  it('round-trips the bounded checkpoint handoff failure flag', () => {
    expect(
      parsePersistedSupervisedLifecycle({
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          reportedL1Ids: [],
          reportedL2Ids: [],
          acceptedKeys: [],
          pendingTurnId: 'turn-1',
          checkpointHandoffFailed: true,
          terminalReviewAccepted: false,
        },
      })?.checkpoints,
    ).toMatchObject({ pendingTurnId: 'turn-1', checkpointHandoffFailed: true });
  });

  it('round-trips bounded durable executor command fences and rejects duplicate command IDs', () => {
    const persisted = {
      executor: {
        ...executor(),
        commands: [
          {
            commandId: 'executor-command-1',
            status: 'issued',
            planIdentity: 'plan',
            planFingerprint: 'fingerprint',
            canonicalPosition: 'L4',
            canonicalTaskName: 'l4',
            taskPath: '/root/l4',
            threadId: 'thread-l4',
            generation: 2,
            trigger: 'partial',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };
    expect(parsePersistedSupervisedLifecycle(persisted)?.executor?.commands).toEqual(
      persisted.executor.commands,
    );
    expect(
      parsePersistedSupervisedLifecycle({
        executor: {
          ...persisted.executor,
          commands: [...persisted.executor.commands, ...persisted.executor.commands],
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    [[{ target: 'l1:l1', epoch: -1, reopened: false, completed: true }], 'negative epoch'],
    [
      Array.from({ length: 641 }, (_, epoch) => ({
        target: `l1:${epoch}`,
        epoch,
        reopened: false,
        completed: true,
      })),
      'oversized history',
    ],
    [[{ target: 'l1:other', epoch: 0, reopened: false, completed: true }], 'partial migration'],
  ])('rejects %s checkpoint epoch persistence', (completionEpochs) => {
    expect(
      parsePersistedSupervisedLifecycle({
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          completionEpochs,
          reportedL1Ids: ['l1'],
          reportedL2Ids: [],
          acceptedKeys: [],
          pendingTurnId: null,
          terminalReviewAccepted: false,
        },
      }),
    ).toBeUndefined();
  });

  it('reparses deterministic cap-edge checkpoint mirrors', () => {
    const l1 = Array.from({ length: 128 }, (_, index) => `l1-${index}`);
    const l2 = Array.from({ length: 512 }, (_, index) => `l2-${index}`);
    const parsed = parsePersistedSupervisedLifecycle({
      checkpoints: {
        protocolVersion: 1,
        planIdentity: 'plan',
        completionEpochs: [
          ...l1.map((id) => ({
            target: JSON.stringify(['l1', id]),
            epoch: 0,
            reopened: false,
            completed: true,
          })),
          ...l2.map((id) => ({
            target: JSON.stringify(['l2', 'l1-0', id]),
            epoch: 0,
            reopened: false,
            completed: true,
          })),
        ].sort((left, right) => left.target.localeCompare(right.target)),
        reportedL1Ids: l1,
        reportedL2Ids: l2.map((id) => JSON.stringify(['l1-0', id])),
        acceptedKeys: Array.from({ length: 768 }, (_, index) => `key-${index}`),
        pendingTurnId: null,
        terminalReviewAccepted: false,
      },
    });
    expect(parsed?.checkpoints?.completionEpochs).toHaveLength(640);
    expect(parsed?.checkpoints?.acceptedKeys).toHaveLength(768);
    expect(parsed?.checkpoints?.completionEpochs?.map((epoch) => epoch.target)).toEqual(
      parsed?.checkpoints?.completionEpochs?.map((epoch) => epoch.target).toSorted(),
    );
  });

  it.each([
    JSON.stringify(['l1', '']),
    JSON.stringify(['l2', 'l1', 'x'.repeat(513)]),
    'l1:',
    `l2:a:${'x'.repeat(513)}`,
  ])('rejects malformed bounded checkpoint target', (target) => {
    expect(
      parsePersistedSupervisedLifecycle({
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          completionEpochs: [{ target, epoch: 0, reopened: false, completed: true }],
          reportedL1Ids: [],
          reportedL2Ids: [],
          acceptedKeys: [],
          pendingTurnId: null,
          terminalReviewAccepted: false,
        },
      }),
    ).toBeUndefined();
  });

  it('treats an incomplete FINAL_ANSWER as partial and rejects the root final', () => {
    expect(
      classifyExecutorOutcome({
        objectiveComplete: false,
        reportedOutcome: 'blocked',
        finalText: 'L4 remains incomplete',
      }),
    ).toEqual({ classification: 'recoverableFailure', outcome: 'partial' });
    expect(decideSupervisedLifecycle(input({ event: 'rootFinalAttempt' }))).toMatchObject({
      finalAllowed: false,
      action: { kind: 'resumeExecutor', threadId: 'thread-l4', generation: 2 },
    });
  });

  it('numbers logical follow-ups independently from the physical executor generation', () => {
    expect(
      decideSupervisedLifecycle(
        input({
          executor: executor({ continuationGeneration: 1, continuationCount: 2 }),
        }),
      ),
    ).toMatchObject({
      finalAllowed: false,
      action: { kind: 'resumeExecutor', threadId: 'thread-l4', generation: 4 },
    });
  });

  it.each([
    ['DONE milestone', { objectiveComplete: true, reportedOutcome: 'partial' as const }, 'done'],
    [
      'recoverable executor failure',
      { objectiveComplete: false, reportedOutcome: 'failed' as const },
      'recoverableFailure',
    ],
    [
      'genuine structured blocker',
      {
        objectiveComplete: false,
        reportedOutcome: 'blocked' as const,
        blockingReason: 'missingDependency' as const,
        resumeCondition: 'dependencyInstalled' as const,
      },
      'blocker',
    ],
    [
      'ongoing work',
      { objectiveComplete: false, reportedOutcome: 'partial' as const, active: true },
      'ongoing',
    ],
  ])('classifies %s without parsing report prose', (_name, input, classification) => {
    expect(classifyExecutorOutcome(input)).toMatchObject({ classification });
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
