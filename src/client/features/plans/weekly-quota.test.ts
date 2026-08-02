/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import type { SupervisedPlan } from './contracts.js';
import { weeklyQuotaUsed } from './weekly-quota.js';

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

describe('weeklyQuotaUsed', () => {
  it('returns the rounded used weekly percentage on the active step', () => {
    expect(weeklyQuotaUsed(plan(62.7))).toBe(37);
  });

  it('keeps unavailable, invalid, and inactive measurements hidden', () => {
    expect(weeklyQuotaUsed(plan())).toBeNull();
    expect(weeklyQuotaUsed(plan(101))).toBeNull();
    expect(weeklyQuotaUsed(undefined)).toBeNull();
  });
});
