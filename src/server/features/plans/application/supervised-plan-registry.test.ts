/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { SupervisedPlanRegistry } from './supervised-plan-registry.js';

const plan = (reviewStatus: 'UNREVIEWED' | 'REVIEWED') => ({
  title: 'Plan',
  totalSteps: 1,
  doneSteps: 1,
  allDone: reviewStatus === 'REVIEWED',
  currentStepId: 'l1',
  steps: [
    {
      id: 'l1',
      title: 'L1',
      level: 1 as const,
      state: 'DONE' as const,
      priority: 'A' as const,
      reviewStatus,
      description: {},
      children: [],
    },
  ],
});

describe('SupervisedPlanRegistry', () => {
  it('replaces stale cached review state with the latest durable publication', () => {
    const registry = new SupervisedPlanRegistry();
    registry.accept('session', {
      kind: 'updated',
      plan: plan('UNREVIEWED'),
      identity: 'identity',
      planPath: '/workspace/plan.org',
      reason: 'checkpoint',
    });
    registry.accept('session', {
      kind: 'updated',
      plan: plan('REVIEWED'),
      identity: 'identity',
      planPath: '/workspace/plan.org',
      reason: 'review:l1:REVIEWED',
    });
    expect(registry.find('session')?.steps[0]).toMatchObject({
      state: 'DONE',
      reviewStatus: 'REVIEWED',
    });
    expect(registry.publicationReason('session')).toBe('review:l1:REVIEWED');
  });
});
