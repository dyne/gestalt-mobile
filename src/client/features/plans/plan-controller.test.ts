/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import type { SupervisedPlan } from './contracts.js';
import { createPlanController, type PlanState } from './plan-controller.js';

const plan = (title = 'Plan', allDone = false): SupervisedPlan => ({
  title,
  steps: [],
  totalSteps: 2,
  doneSteps: allDone ? 2 : 1,
  allDone,
  currentStepId: 'step-1',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('plan controller', () => {
  it('loads the selected session and represents a missing retained plan explicitly', async () => {
    const states: PlanState[] = [];
    const controller = createPlanController(
      {
        getPlan: vi.fn().mockResolvedValueOnce(plan()).mockResolvedValueOnce(null),
        closePlan: vi.fn(),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ kind: 'ready', sessionId: 'one' }),
    );
    controller.select('two');
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ kind: 'unavailable', sessionId: 'two' }),
    );
  });

  it('accepts complete plan replacements, retains completion, and deduplicates replay', async () => {
    const states: PlanState[] = [];
    const controller = createPlanController(
      { getPlan: vi.fn().mockResolvedValue(null), closePlan: vi.fn() },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('unavailable'));
    controller.applyEvent('one', { sequence: 4, type: 'plan.updated', payload: plan('First') });
    controller.applyEvent('one', { sequence: 4, type: 'plan.updated', payload: plan('Duplicate') });
    controller.applyEvent('one', {
      sequence: 5,
      type: 'plan.updated',
      payload: plan('Complete', true),
    });
    expect(states.at(-1)).toMatchObject({
      kind: 'ready',
      plan: { title: 'Complete', allDone: true },
    });
    expect(states.filter((state) => state.kind === 'ready')).toHaveLength(2);
  });

  it('never lets a stale session response or event render after a session switch', async () => {
    const one = deferred<SupervisedPlan | null>();
    const two = deferred<SupervisedPlan | null>();
    const states: PlanState[] = [];
    const controller = createPlanController(
      {
        getPlan: vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise),
        closePlan: vi.fn(),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    controller.select('two');
    controller.applyEvent('one', {
      sequence: 1,
      type: 'plan.updated',
      payload: plan('Wrong session'),
    });
    one.resolve(plan('Stale response'));
    two.resolve(plan('Current response'));
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ kind: 'ready', sessionId: 'two' }),
    );
    expect(
      states.some((state) => state.kind === 'ready' && state.plan.title !== 'Current response'),
    ).toBe(false);
  });

  it('keeps the last good view through a transient refresh failure', async () => {
    const states: PlanState[] = [];
    const controller = createPlanController(
      {
        getPlan: vi
          .fn()
          .mockResolvedValueOnce(plan('Stable'))
          .mockRejectedValueOnce(new Error('offline')),
        closePlan: vi.fn(),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ kind: 'ready' }));
    controller.refresh('one');
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ kind: 'error', plan: { title: 'Stable' } }),
    );
  });

  it('closes only the completed selected plan and gives deterministic Chat fallback', async () => {
    const states: PlanState[] = [];
    const closePlan = vi.fn().mockResolvedValue(undefined);
    const controller = createPlanController(
      { getPlan: vi.fn().mockResolvedValue(plan('Complete', true)), closePlan },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('ready'));
    await expect(controller.close()).resolves.toBe('chat');
    expect(closePlan).toHaveBeenCalledWith('one');
    expect(states.at(-1)).toEqual({ kind: 'unavailable', sessionId: 'one' });
  });

  it('keeps completion visible with explicit feedback when close fails, and accepts plan.closed', async () => {
    const states: PlanState[] = [];
    const controller = createPlanController(
      {
        getPlan: vi.fn().mockResolvedValue(plan('Complete', true)),
        closePlan: vi.fn().mockRejectedValue(new Error('busy')),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('ready'));
    await expect(controller.close()).resolves.toBeNull();
    expect(states.at(-1)).toMatchObject({
      kind: 'error',
      error: 'busy',
      plan: { title: 'Complete' },
    });
    controller.applyEvent('one', { sequence: 8, type: 'plan.closed', payload: {} });
    expect(states.at(-1)).toEqual({ kind: 'unavailable', sessionId: 'one' });
  });

  it('keeps a plan.closed transition and requests Chat when the pending close rejects', async () => {
    const states: PlanState[] = [];
    const request = deferred<void>();
    const controller = createPlanController(
      {
        getPlan: vi.fn().mockResolvedValue(plan('Complete', true)),
        closePlan: vi.fn().mockReturnValue(request.promise),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('ready'));
    const closing = controller.close();
    expect(states.at(-1)?.kind).toBe('closing');
    controller.applyEvent('one', { sequence: 8, type: 'plan.closed', payload: {} });
    request.reject(new Error('late failure'));
    await expect(closing).resolves.toBe('chat');
    expect(states.at(-1)).toEqual({ kind: 'unavailable', sessionId: 'one' });
  });

  it('keeps a newer plan.updated transition when the pending close rejects', async () => {
    const states: PlanState[] = [];
    const request = deferred<void>();
    const controller = createPlanController(
      {
        getPlan: vi.fn().mockResolvedValue(plan('Complete', true)),
        closePlan: vi.fn().mockReturnValue(request.promise),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('ready'));
    const closing = controller.close();
    controller.applyEvent('one', {
      sequence: 8,
      type: 'plan.updated',
      payload: plan('Replacement'),
    });
    request.reject(new Error('late failure'));
    await expect(closing).resolves.toBeNull();
    expect(states.at(-1)).toMatchObject({
      kind: 'ready',
      sessionId: 'one',
      plan: { title: 'Replacement' },
    });
  });

  it('does not alter a newly selected session or request navigation when a pending close succeeds', async () => {
    const states: PlanState[] = [];
    const request = deferred<void>();
    const controller = createPlanController(
      {
        getPlan: vi
          .fn()
          .mockResolvedValueOnce(plan('Complete', true))
          .mockResolvedValueOnce(plan('Second session')),
        closePlan: vi.fn().mockReturnValue(request.promise),
      },
      (state) => states.push(state),
    );
    controller.select('one');
    await vi.waitFor(() => expect(states.at(-1)?.kind).toBe('ready'));
    const closing = controller.close();
    controller.select('two');
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ kind: 'ready', sessionId: 'two' }),
    );
    request.resolve();
    await expect(closing).resolves.toBeNull();
    expect(states.at(-1)).toMatchObject({
      kind: 'ready',
      sessionId: 'two',
      plan: { title: 'Second session' },
    });
  });

  it('cleans up outstanding requests', () => {
    const states: PlanState[] = [];
    const request = deferred<SupervisedPlan | null>();
    const controller = createPlanController(
      { getPlan: vi.fn().mockReturnValue(request.promise), closePlan: vi.fn() },
      (state) => states.push(state),
    );
    controller.select('one');
    controller.dispose();
    request.resolve(plan());
    expect(states.at(-1)).toEqual({ kind: 'unavailable', sessionId: null });
  });
});
