/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { SupervisedPlan } from './contracts.js';
import PlanProgress from './PlanProgress.svelte';

afterEach(cleanup);

const plan: SupervisedPlan = {
  title: 'Compact session progress',
  steps: [
    {
      id: 'layout',
      title: 'Layout',
      level: 1,
      state: 'WIP',
      priority: 'A',
      description: {},
      children: [
        {
          id: 'layout-card',
          title: 'Card',
          level: 2,
          state: 'DONE',
          priority: 'A',
          description: {},
          children: [],
        },
      ],
    },
    {
      id: 'verify',
      title: 'Verify',
      level: 1,
      state: 'TODO',
      priority: 'A',
      description: {},
      children: [],
    },
  ],
  totalSteps: 3,
  doneSteps: 1,
  allDone: false,
  currentStepId: 'layout',
};

describe('PlanProgress', () => {
  it('shows the same aggregate and positioned step states in compact mode', () => {
    const { container } = render(PlanProgress, {
      plan,
      compact: true,
      label: 'Plan progress for session one',
    });

    const progress = screen.getByRole('progressbar', { name: 'Plan progress for session one' });
    expect(progress.getAttribute('value')).toBe('1');
    expect(progress.getAttribute('max')).toBe('3');
    expect(screen.getByRole('list', { name: 'Plan step progress' })).toBeTruthy();
    expect(screen.getByLabelText('L1: WIP').getAttribute('aria-current')).toBe('step');
    expect(screen.getByLabelText('L1.1: DONE')).toBeTruthy();
    expect(screen.getByLabelText('L2: TODO')).toBeTruthy();
    expect(container.querySelector('.plan-progress')?.classList.contains('compact')).toBe(true);
  });
});
