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
        {
          id: 'layout-progress',
          title: 'Progress details',
          level: 2,
          state: 'WIP',
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
  totalSteps: 4,
  doneSteps: 1,
  allDone: false,
  currentStepId: 'layout',
};

describe('PlanProgress', () => {
  it('shows aggregate progress and only titled WIP steps in compact mode', () => {
    const compactPlan: SupervisedPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          description: { effort: 'Medium' },
        },
        plan.steps[1]!,
      ],
    };
    const { container } = render(PlanProgress, {
      plan: compactPlan,
      compact: true,
      label: 'Plan progress for session one',
    });

    const progress = screen.getByRole('progressbar', { name: 'Plan progress for session one' });
    expect(progress.getAttribute('value')).toBe('1');
    expect(progress.getAttribute('max')).toBe('4');
    expect(screen.getByRole('list', { name: 'Work in progress plan steps' })).toBeTruthy();
    expect(
      screen.getByLabelText('L1: Layout, WIP, effort Medium').getAttribute('aria-current'),
    ).toBe('step');
    expect(screen.getByLabelText('L1.2: Progress details, WIP')).toBeTruthy();
    expect(screen.getByText('Effort: Medium')).toBeTruthy();
    expect(screen.queryByLabelText('L1.1: Card, DONE')).toBeNull();
    expect(screen.queryByLabelText('L2: Verify, TODO')).toBeNull();
    expect(screen.queryByText('Card')).toBeNull();
    expect(screen.queryByText('Verify')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Plan step progress' })).toBeNull();
    expect(container.querySelector('.plan-progress')?.classList.contains('compact')).toBe(true);
  });

  it('retains every positioned step marker outside compact mode', () => {
    render(PlanProgress, { plan });

    expect(screen.getByRole('list', { name: 'Plan step progress' })).toBeTruthy();
    expect(screen.getByLabelText('L1: WIP')).toBeTruthy();
    expect(screen.getByLabelText('L1.1: DONE')).toBeTruthy();
    expect(screen.getByLabelText('L1.2: WIP')).toBeTruthy();
    expect(screen.getByLabelText('L2: TODO')).toBeTruthy();
  });
});
