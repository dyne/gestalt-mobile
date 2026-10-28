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

it('latches mandatory-policy failures independently per session until a validated publication repairs them', () => {
  const registry = new SupervisedPlanRegistry();
  const update = {
    kind: 'updated' as const,
    plan: plan('UNREVIEWED'),
    identity: 'p',
    planPath: '/work/plan.org',
    reason: 'resync' as const,
  };
  registry.accept('a', update);
  registry.accept('b', update);
  registry.accept('a', {
    kind: 'unavailable',
    code: 'PLAN_STATUS_UNAVAILABLE',
    modelPolicyRequired: true,
  });
  expect(registry.find('a')).toEqual(update.plan);
  expect(registry.findCurrent('a')).toBeNull();
  expect(registry.findCurrent('b')).toEqual(update.plan);
  expect(registry.modelPolicyStatus('a')).toBe('unavailable');
  expect(registry.modelPolicyStatus('b')).toBe('legacy');
  registry.accept('a', { kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
  expect(registry.modelPolicyStatus('a')).toBe('unavailable');
  registry.accept('a', { ...update, plan: { ...update.plan, modelPolicyVersion: 1 } });
  expect(registry.modelPolicyStatus('a')).toBe('required');
  registry.accept('a', { kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
  expect(registry.modelPolicyStatus('a')).toBe('unavailable');
  registry.accept('a', update);
  expect(registry.findCurrent('a')).toEqual(update.plan);
  expect(registry.modelPolicyStatus('a')).toBe('legacy');
  registry.clear('a');
  expect(registry.modelPolicyStatus('a')).toBe('legacy');
});

it('does not let an invalid legacy publication retain capability authority', () => {
  const registry = new SupervisedPlanRegistry();
  const update = {
    kind: 'updated' as const,
    plan: plan('UNREVIEWED'),
    identity: 'p',
    planPath: '/work/plan.org',
    reason: 'resync' as const,
  };
  registry.accept('a', update);
  registry.accept('a', { kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' });
  expect(registry.find('a')).toEqual(update.plan);
  expect(registry.findCurrent('a')).toBeNull();
  registry.accept('a', update);
  expect(registry.findCurrent('a')).toEqual(update.plan);
});
