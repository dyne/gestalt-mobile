/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { threadPlanName } from './thread-plan-name.js';

const plan = (state: 'TODO' | 'WIP' | 'DONE', reviewStatus: 'UNREVIEWED' | 'REVIEWED' = 'UNREVIEWED') => ({
  title: 'Roadmap', totalSteps: 1, doneSteps: state === 'DONE' ? 1 : 0, allDone: state === 'DONE', currentStepId: 'l1', steps: [{ id: 'l1', title: 'Ship', level: 1 as const, state, priority: 'A' as const, reviewStatus, description: {}, children: [] }],
});

describe('threadPlanName', () => {
  it('derives authoring, active, review, and complete labels', () => {
    expect(threadPlanName(plan('TODO'))).toBe('Roadmap — Authoring');
    expect(threadPlanName(plan('WIP'))).toBe('Roadmap — L1 1/1');
    expect(threadPlanName(plan('DONE'))).toBe('Roadmap — Review 1/1');
    expect(threadPlanName(plan('DONE', 'REVIEWED'))).toBe('Roadmap — Complete');
  });
  it('truncates Unicode titles without losing the suffix', () => {
    expect(threadPlanName({ ...plan('WIP'), title: '🙂'.repeat(20) }, 12)).toBe('🙂🙂… — L1 1/1');
  });
});
