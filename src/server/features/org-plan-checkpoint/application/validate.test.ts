/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { validOrgPlanCheckpoint } from './validate.js';

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
      children: [],
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
