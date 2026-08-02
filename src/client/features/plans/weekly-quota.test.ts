/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import type { SupervisedPlan } from './contracts.js';
import { weeklyQuotaLeft } from './weekly-quota.js';

const plan = (remaining?: number): SupervisedPlan => ({
  title: 'Weekly quota',
  steps: [{
    id: 'l1', title: 'Parent', level: 1, state: 'WIP', priority: 'A', description: {}, children: [
      {
        id: 'l2', title: 'Active', level: 2, state: 'WIP', priority: 'A', description: {},
        ...(remaining === undefined ? {} : { measurement: { weeklyRemainingCurrent: remaining } }),
        children: [],
      },
    ],
  }],
  totalSteps: 2,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'l2',
});

describe('weeklyQuotaLeft', () => {
  it('returns the rounded remaining weekly percentage on the active step', () => {
    expect(weeklyQuotaLeft(plan(62.7))).toBe(63);
  });

  it('keeps unavailable, invalid, and inactive measurements hidden', () => {
    expect(weeklyQuotaLeft(plan())).toBeNull();
    expect(weeklyQuotaLeft(plan(101))).toBeNull();
    expect(weeklyQuotaLeft(undefined)).toBeNull();
  });
});
