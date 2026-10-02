/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  hasActiveL1Writer,
  resolveOrgPlanCheckpointSignal,
  validateOrgPlanCheckpoint,
  validOrgPlanCheckpoint,
} from './validate.js';

const plan = {
  title: 'Plan',
  totalSteps: 1,
  doneSteps: 1,
  allDone: true,
  currentStepId: 'l1',
  steps: [
    {
      id: 'l1',
      title: 'L1',
      level: 1 as const,
      state: 'DONE' as const,
      priority: 'A' as const,
      reviewStatus: 'REVIEWED' as const,
      description: {},
      children: [
        {
          id: 'l2',
          title: 'L2',
          level: 2 as const,
          state: 'DONE' as const,
          priority: 'A' as const,
          description: {},
          children: [],
        },
      ],
    },
  ],
};
const checkpoint = {
  version: 1 as const,
  kind: 'l1Accepted' as const,
  planIdentity: 'plan',
  l1Id: 'l1',
  position: 'L1',
  verdict: 'ACCEPT' as const,
  commit: { kind: 'notRequired' as const },
};

describe('validOrgPlanCheckpoint', () => {
  it('accepts retained terminal executors and rejects only genuine active writers', () => {
    expect(
      hasActiveL1Writer(
        { subagents: [{ canonicalPosition: 'L1', state: 'idle', outcome: 'partial' }] },
        'L1',
      ),
    ).toBe(false);
    expect(
      hasActiveL1Writer(
        { subagents: [{ canonicalPosition: 'L1', state: 'idle', outcome: 'cancelled' }] },
        'L1',
      ),
    ).toBe(false);
    expect(
      hasActiveL1Writer({ subagents: [{ canonicalPosition: 'L1', state: 'working' }] }, 'L1'),
    ).toBe(true);
  });
  it('expands a compact host signal from the authoritative current boundary', () => {
    const current = {
      ...plan,
      currentStepId: 'l1',
      steps: [
        {
          ...plan.steps[0],
          state: 'WIP' as const,
          reviewStatus: 'UNREVIEWED' as const,
        },
      ],
    };
    expect(resolveOrgPlanCheckpointSignal('l2Completed', current, 'plan')).toMatchObject({
      kind: 'l2Completed',
      planIdentity: 'plan',
      l1Id: 'l1',
      l2Id: 'l2',
      position: 'L1.1',
    });
  });
  it('resolves an accepted L1 after REVIEWED advances the current step to the next TODO L1', () => {
    const next = {
      id: 'l2-next',
      title: 'Next L1',
      level: 1 as const,
      state: 'TODO' as const,
      priority: 'B' as const,
      reviewStatus: 'UNREVIEWED' as const,
      description: {},
      children: [],
    };
    const advanced = {
      ...plan,
      allDone: false,
      currentStepId: next.id,
      steps: [plan.steps[0], next],
    };
    expect(resolveOrgPlanCheckpointSignal('l1Accepted', advanced, 'plan')).toMatchObject({
      kind: 'l1Accepted',
      l1Id: 'l1',
      position: 'L1',
    });
    expect(
      resolveOrgPlanCheckpointSignal('l1Accepted', advanced, 'plan', 'review:l1:REVIEWED'),
    ).toMatchObject({ l1Id: 'l1', position: 'L1' });
  });
  it('requires a matching DONE L2 under an unreviewed L1', () => {
    const l2Checkpoint = {
      version: 1 as const,
      kind: 'l2Completed' as const,
      planIdentity: 'plan',
      l1Id: 'l1',
      l2Id: 'l2',
      position: 'L1.1',
      status: 'DONE' as const,
      changes: 'Completed L2.',
      files: 'src/reporting.ts',
      tests: 'Focused tests passed.',
    };
    const input = {
      checkpoint: l2Checkpoint,
      plan: {
        ...plan,
        steps: [
          {
            ...plan.steps[0],
            state: 'WIP' as const,
            reviewStatus: 'UNREVIEWED' as const,
          },
        ],
      },
      planIdentity: 'plan',
      rootOwned: true,
      hasActiveL1Writer: () => true,
    };
    expect(validOrgPlanCheckpoint(input)).toBe(true);
    expect(
      validOrgPlanCheckpoint({
        ...input,
        checkpoint: { ...l2Checkpoint, position: 'L1.2' },
      }),
    ).toBe(false);
    expect(
      validOrgPlanCheckpoint({
        ...input,
        plan: {
          ...input.plan,
          steps: [
            {
              ...input.plan.steps[0],
              children: [{ ...input.plan.steps[0].children[0], state: 'WIP' as const }],
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('requires the active root, matching reviewed L1, and no active writer', () => {
    const input = {
      checkpoint,
      plan,
      planIdentity: 'plan',
      rootOwned: true,
      hasActiveL1Writer: () => false,
    };
    expect(validOrgPlanCheckpoint(input)).toBe(true);
    expect(validOrgPlanCheckpoint({ ...input, rootOwned: false })).toBe(false);
    expect(validOrgPlanCheckpoint({ ...input, hasActiveL1Writer: () => true })).toBe(false);
    expect(
      validOrgPlanCheckpoint({ ...input, checkpoint: { ...checkpoint, position: 'L2' } }),
    ).toBe(false);
  });
  it('returns precise accepted-L1 diagnostics for incomplete work and an active writer', () => {
    const input = {
      checkpoint,
      plan,
      planIdentity: 'plan',
      rootOwned: true,
      hasActiveL1Writer: () => false,
    };
    expect(
      validateOrgPlanCheckpoint({
        ...input,
        plan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0],
              children: [{ ...plan.steps[0].children[0], state: 'WIP' as const }],
            },
          ],
        },
      }),
    ).toMatchObject({ valid: false, reasonCode: 'l1ChildrenIncomplete' });
    expect(validateOrgPlanCheckpoint({ ...input, hasActiveL1Writer: () => true })).toMatchObject({
      valid: false,
      reasonCode: 'executorStillActive',
      observed: { executorTerminal: false },
    });
  });
  it('requires every L1 reviewed for terminal acceptance', () => {
    expect(
      validOrgPlanCheckpoint({
        checkpoint: {
          version: 1,
          kind: 'terminalReviewAccepted',
          planIdentity: 'plan',
          verdict: 'ACCEPT',
        },
        plan,
        planIdentity: 'plan',
        rootOwned: true,
        hasActiveL1Writer: () => false,
      }),
    ).toBe(true);
    expect(
      validOrgPlanCheckpoint({
        checkpoint: {
          version: 1,
          kind: 'terminalReviewAccepted',
          planIdentity: 'plan',
          verdict: 'ACCEPT',
        },
        plan: { ...plan, steps: [{ ...plan.steps[0], reviewStatus: 'UNREVIEWED' as const }] },
        planIdentity: 'plan',
        rootOwned: true,
        hasActiveL1Writer: () => false,
      }),
    ).toBe(false);
  });
});
