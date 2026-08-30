/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { presentPlan } from './plan-presentation.js';
import type { SupervisedPlan } from './contracts.js';

const plan = (
  state: 'TODO' | 'WIP' | 'DONE',
  reviewStatus?: 'UNREVIEWED' | 'REVIEWED',
): SupervisedPlan => ({
  title: 'Plan',
  steps: [
    {
      id: 'one',
      title: 'One',
      level: 1,
      state,
      priority: 'A',
      reviewStatus,
      description: {},
      children: [],
    },
  ],
  totalSteps: 1,
  doneSteps: state === 'DONE' ? 1 : 0,
  allDone: state === 'DONE',
  currentStepId: state === 'WIP' ? 'one' : '',
});
describe('presentPlan', () => {
  it('does not call unreviewed or terminal work complete', () => {
    expect(presentPlan(plan('WIP')).label).toBe('Implementing L1 One');
    expect(presentPlan(plan('DONE', 'UNREVIEWED')).label).toBe('Awaiting L1 review');
    expect(presentPlan(plan('DONE', 'REVIEWED')).label).toBe('Terminal review');
  });
});
