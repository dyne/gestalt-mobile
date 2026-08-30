/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanStep, SupervisedPlan } from './contracts.js';
import PlanView from './PlanView.svelte';
import type { PlanState } from './plan-controller.js';

const scrollIntoView = vi.fn();

const l2: PlanStep = {
  id: 'l2-current',
  title: 'Nested current ✓',
  level: 2,
  state: 'WIP',
  priority: 'B',
  reviewStatus: 'REVIEWED',
  skills: ['svelte-code-writer', 'modern-web-guidance'],
  description: {
    effort: 'Small',
    goal: 'Make it readable',
    notes: 'Unicode план',
    why: 'Dense detail',
    change: 'Render every field',
    tests: 'Screen reader',
    doneWhen: 'All text is inspectable',
  },
  children: [],
};

const l1: PlanStep = {
  id: 'l1-parent',
  title: 'Parent step',
  level: 1,
  state: 'TODO',
  priority: 'A',
  reviewStatus: 'UNREVIEWED',
  description: {
    goal: 'A very-long-unbroken-value-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  },
  children: [l2],
};

const otherL1: PlanStep = {
  id: 'l1-manual',
  title: 'Manual disclosure',
  level: 1,
  state: 'DONE',
  priority: 'C',
  description: { notes: 'Keep this open' },
  children: [],
};

function plan(overrides: Partial<SupervisedPlan> = {}): SupervisedPlan {
  return {
    title: 'Unicode план',
    subtitle: 'A retained plan',
    date: '2026-08-01',
    keywords: 'mobile, plan',
    steps: [l1, otherL1],
    totalSteps: 3,
    doneSteps: 1,
    allDone: false,
    currentStepId: l1.id,
    ...overrides,
  };
}

function ready(overrides: Partial<SupervisedPlan> = {}): PlanState {
  return { kind: 'ready', sessionId: 'one', plan: plan(overrides) };
}

function detail(id: string): HTMLDetailsElement {
  return document.querySelector<HTMLDetailsElement>(`details[data-step-id="${id}"]`)!;
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockReset();
});

describe('PlanView', () => {
  it('preserves ordered L1/L2 hierarchy and renders nested fields, indicators, metadata, skills, and progress', () => {
    render(PlanView, { state: ready({ currentStepId: l2.id }), onclose: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Unicode план' })).toBeTruthy();
    expect(
      [...document.querySelectorAll('details')].map((element) => element.dataset.stepId),
    ).toEqual(['l1-parent', 'l2-current', 'l1-manual']);
    expect(detail(l1.id).open).toBe(true);
    expect(detail(l2.id).open).toBe(true);
    expect(screen.getByLabelText('L1: TODO')).toBeTruthy();
    expect(screen.getByLabelText('L1.1: WIP')).toBeTruthy();
    expect(screen.getByLabelText('L2: DONE')).toBeTruthy();
    expect(screen.getByText(/TODO.*Priority A.*UNREVIEWED/)).toBeTruthy();
    expect(screen.getByText(/WIP.*Priority B.*REVIEWED/)).toBeTruthy();
    expect(screen.getByText(/DONE.*Priority C/)).toBeTruthy();
    for (const text of [
      'Effort:',
      'Goal:',
      'Notes:',
      'Why:',
      'Change:',
      'Tests:',
      'Done when:',
      'Skills:',
    ])
      expect(screen.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/very-long-unbroken-value/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Unicode план' })).toBeTruthy();
    expect(screen.getByText('Subtitle')).toBeTruthy();
    expect(screen.getByText('Date')).toBeTruthy();
    expect(screen.getByText('Keywords')).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: 'Plan progress' });
    expect(progress.getAttribute('value')).toBe('1');
    expect(progress.getAttribute('max')).toBe('3');
  });

  it('renders measured values and keeps unavailable measurements explicit', () => {
    const { rerender } = render(PlanView, {
      state: ready({
        steps: [
          {
            ...l1,
            measurement: { elapsedSeconds: 65, weeklyPercentUsed: 0, tokensUsed: 1200 },
            children: [{ ...l2, measurement: undefined }],
          },
        ],
      }),
      onclose: vi.fn(),
    });
    expect(
      screen.getByText('1m 5s elapsed · 0% observed account-wide usage · 1,200 tokens used'),
    ).toBeTruthy();
    rerender({ state: ready({ steps: [{ ...l1, children: [] }] }), onclose: vi.fn() });
    expect(screen.getByText('Measurements unavailable')).toBeTruthy();
  });

  it('auto-opens and scrolls the initial nested current path without stealing focus', async () => {
    const focusProbe = document.createElement('button');
    document.body.append(focusProbe);
    focusProbe.focus();
    render(PlanView, { state: ready({ currentStepId: l2.id }), onclose: vi.fn() });
    await vi.waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      }),
    );
    expect(detail(l1.id).open).toBe(true);
    expect(detail(l2.id).open).toBe(true);
    expect(document.activeElement).toBe(focusProbe);
    focusProbe.remove();
  });

  it('scrolls a replacement current node after its details binding exists without stealing focus', async () => {
    const { rerender } = render(PlanView, { state: ready(), onclose: vi.fn() });
    const focusProbe = document.createElement('button');
    document.body.append(focusProbe);
    focusProbe.focus();
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    scrollIntoView.mockClear();
    const replacement: PlanStep = {
      ...l2,
      id: 'l2-replacement',
      title: 'Newly rendered current',
    };
    rerender({
      state: ready({
        currentStepId: replacement.id,
        steps: [{ ...l1, children: [...l1.children, replacement] }, otherL1],
      }),
      onclose: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      }),
    );
    expect(detail(l1.id).open).toBe(true);
    expect(detail(replacement.id).open).toBe(true);
    expect(document.activeElement).toBe(focusProbe);
    focusProbe.remove();
  });

  it('retains a manually opened disclosure when the current step is replaced', async () => {
    const { rerender } = render(PlanView, { state: ready(), onclose: vi.fn() });
    const manual = detail(otherL1.id);
    manual.open = true;
    manual.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(manual.open).toBe(true));

    rerender({ state: ready({ currentStepId: l2.id }), onclose: vi.fn() });
    await vi.waitFor(() => expect(detail(otherL1.id).open).toBe(true));
  });

  it('announces meaningful current step changes once without replacing the same announcement', async () => {
    const { rerender } = render(PlanView, { state: ready(), onclose: vi.fn() });
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain('Implementing L1 Parent step');
    const before = live.textContent;
    rerender({ state: ready(), onclose: vi.fn() });
    expect(live.textContent).toBe(before);

    rerender({ state: ready({ currentStepId: l2.id }), onclose: vi.fn() });
    await vi.waitFor(() =>
      expect(live.textContent).toContain('Implementing L1.1 Nested current ✓'),
    );
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it('handles optional metadata, empty plans, and loading/unavailable/error states clearly', () => {
    const { rerender } = render(PlanView, {
      state: ready({ subtitle: undefined, date: undefined, keywords: undefined }),
      onclose: vi.fn(),
    });
    expect(document.querySelector('.metadata')).toBeNull();

    rerender({
      state: ready({ steps: [], totalSteps: 0, doneSteps: 0, currentStepId: '' }),
      onclose: vi.fn(),
    });
    expect(screen.getByText('No plan steps have been retained yet.')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('max')).toBe('1');
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('0');

    rerender({ state: { kind: 'loading', sessionId: 'one' }, onclose: vi.fn() });
    expect(screen.getByText('Loading plan…')).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Loading plan.');
    rerender({ state: { kind: 'unavailable', sessionId: 'one' }, onclose: vi.fn() });
    expect(screen.getAllByText('No retained plan for this session.').length).toBeGreaterThan(1);
    rerender({ state: { kind: 'error', sessionId: 'one', error: 'Offline' }, onclose: vi.fn() });
    expect(screen.getAllByText('Offline').length).toBeGreaterThan(1);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Offline');
  });

  it('shows an accessible 44px non-destructive return control for incomplete and completed plans', async () => {
    const onclose = vi.fn();
    const { rerender } = render(PlanView, { state: ready(), onclose });
    const close = screen.getByRole('button', { name: 'Close plan and return to list' });
    expect(close.classList.contains('close')).toBe(true);
    await fireEvent.click(close);
    expect(onclose).toHaveBeenCalledTimes(1);

    const completed = plan({ allDone: true, doneSteps: 3 });
    rerender({ state: { kind: 'ready', sessionId: 'one', plan: completed }, onclose });
    expect(screen.getByRole('button', { name: 'Close plan and return to list' })).toBeTruthy();

    rerender({ state: { kind: 'closing', sessionId: 'one', plan: completed }, onclose });
    expect(
      (screen.getByRole('button', { name: 'Close plan and return to list' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Closing completed plan.',
    );

    rerender({
      state: { kind: 'error', sessionId: 'one', plan: completed, error: 'Relay is busy' },
      onclose,
    });
    expect(screen.getByText('Relay is busy')).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Relay is busy');
    expect(
      (screen.getByRole('button', { name: 'Close plan and return to list' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
