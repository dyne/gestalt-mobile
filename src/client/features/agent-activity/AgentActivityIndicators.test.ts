/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AgentActivityIndicators from './AgentActivityIndicators.svelte';

describe('AgentActivityIndicators', () => {
  it('does not churn polite announcements for timestamp-only rerenders', async () => {
    const activity = {
      sessionId: 's',
      confidence: 'fresh' as const,
      aggregateSubagents: 'idle' as const,
      root: {
        state: 'working' as const,
        observedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
      subagents: [],
    };
    const view = render(AgentActivityIndicators, { activity });
    const live = view.container.querySelector('[aria-live="polite"]')!;
    const before = live.textContent;
    await view.rerender({
      activity: { ...activity, root: { ...activity.root, observedAt: '2026-01-02T00:00:00.000Z' } },
    });
    expect(live.textContent).toBe(before);
  });
  it('deduplicates repeated critical activity and announces it again for a new session', async () => {
    const activity = {
      sessionId: 'a',
      confidence: 'fresh' as const,
      aggregateSubagents: 'blocked' as const,
      root: {
        state: 'blocked' as const,
        observedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
      subagents: [],
    };
    const view = render(AgentActivityIndicators, { activity });
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Supervisor blocked.');
    await view.rerender({
      activity: { ...activity, root: { ...activity.root, observedAt: 'later' } },
    });
    expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    await view.rerender({ activity: { ...activity, sessionId: 'b' } });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Supervisor blocked.');
  });
  it('labels reconciling freshness and preserves a native disclosure target', () => {
    const view = render(AgentActivityIndicators, {
      activity: {
        sessionId: 's',
        confidence: 'reconciling',
        aggregateSubagents: 'idle',
        root: {
          state: 'idle',
          observedAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
        subagents: [],
      },
    });
    expect(screen.getByText('Checking updates')).toBeTruthy();
    expect(view.container.querySelector('summary')?.className).toContain('chip');
  });
  for (const state of [
    'working',
    'idle',
    'awaitingAgent',
    'awaitingHuman',
    'blocked',
    'disconnected',
  ] as const) {
    it(`labels ${state} without relying on color`, () => {
      render(AgentActivityIndicators, {
        activity: {
          sessionId: 's',
          confidence: 'fresh',
          aggregateSubagents: state,
          root: {
            state,
            observedAt: '2026-01-01T00:00:00.000Z',
            lastActivityAt: '2026-01-01T00:00:00.000Z',
          },
          subagents: [],
        },
      });
      expect(screen.getByText(/Supervisor:/).textContent).toBeTruthy();
    });
  }
  it('uses native disclosure and readable labels for critical child activity', () => {
    const { container } = render(AgentActivityIndicators, {
      activity: {
        sessionId: 's',
        confidence: 'stale',
        aggregateSubagents: 'blocked',
        root: {
          state: 'awaitingHuman',
          observedAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
        subagents: [
          {
            id: '子-agent',
            nickname: 'Álpha 子',
            role: 'worker',
            state: 'blocked',
            observedAt: '2026-01-01T00:00:00.000Z',
            lastActivityAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(screen.getByText('Supervisor: needs you')).toBeTruthy();
    expect(screen.getByText('May be stale')).toBeTruthy();
    expect(container.querySelector('details summary')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Supervisor needs you.');
  });
  it('combines root and child agents with compact latest-activity times', () => {
    const now = Date.now();
    render(AgentActivityIndicators, {
      compact: true,
      rootModel: 'gpt-5.6-sol',
      activity: {
        sessionId: 's',
        confidence: 'fresh',
        aggregateSubagents: 'idle',
        root: {
          state: 'idle',
          observedAt: new Date(now - 2 * 60_000).toISOString(),
          lastActivityAt: new Date(now - 2 * 60_000).toISOString(),
        },
        subagents: [
          {
            id: 'child-1',
            nickname: 'Worker',
            role: 'explorer',
            model: 'gpt-5.6-luna',
            state: 'idle',
            observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
            lastActivityAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          },
        ],
      },
    });

    const agents = screen.getByText('Agents (2)');
    expect(agents).toBeTruthy();
    expect(agents.classList.contains('app-control')).toBe(true);
    expect(screen.queryByText('Current')).toBeNull();
    expect(screen.getByText('Supervisor')).toBeTruthy();
    expect(screen.getByText('Non-plan agent — Worker')).toBeTruthy();
    expect(screen.getByText('supervisor · Model: gpt-5.6-sol')).toBeTruthy();
    expect(screen.getByText('explorer · Model: gpt-5.6-luna')).toBeTruthy();
    expect(screen.getByText('idle since 2m')).toBeTruthy();
    expect(screen.getByText('idle since 2h')).toBeTruthy();
  });
  it('keeps the root agent visible while activity is unavailable', () => {
    const { container } = render(AgentActivityIndicators, {
      compact: true,
      activity: null,
    });

    expect(screen.getByText('Agents (1)')).toBeTruthy();
    expect(screen.getByText('Root agent')).toBeTruthy();
    expect(screen.getByText('activity unavailable')).toBeTruthy();
    expect(getComputedStyle(container.querySelector('.agent-activity')!).display).not.toBe('none');
  });
  it('orders the root then plan positions before lifecycle state', () => {
    const now = new Date().toISOString();
    const { container } = render(AgentActivityIndicators, {
      compact: true,
      activity: {
        sessionId: 's',
        confidence: 'fresh',
        aggregateSubagents: 'working',
        root: { state: 'idle', observedAt: now, lastActivityAt: now },
        subagents: [
          {
            id: 'offline',
            nickname: 'Offline',
            state: 'disconnected',
            observedAt: now,
            lastActivityAt: now,
          },
          {
            id: 'worker',
            nickname: 'Worker',
            state: 'working',
            observedAt: now,
            lastActivityAt: now,
          },
        ],
      },
    });

    expect(
      [...container.querySelectorAll('.agents li strong')].map((node) => node.textContent),
    ).toEqual(['Supervisor', 'Non-plan agent — Worker', 'Non-plan agent — Offline']);
  });
  it('presents a dedicated plan subagent with its canonical position label', () => {
    const now = new Date().toISOString();
    render(AgentActivityIndicators, {
      plan: {
        title: 'Canonical roster',
        steps: [
          {
            id: 'l1',
            title: 'Other L1',
            level: 1,
            state: 'TODO',
            priority: 'A',
            description: {},
            children: [],
          },
          {
            id: 'l2',
            title: 'Current L2 title',
            level: 1,
            state: 'WIP',
            priority: 'A',
            description: {},
            children: [],
          },
        ],
        totalSteps: 2,
        doneSteps: 0,
        allDone: false,
        currentStepId: 'l2',
      },
      activity: {
        sessionId: 's',
        confidence: 'fresh',
        aggregateSubagents: 'idle',
        root: { state: 'idle', observedAt: now, lastActivityAt: now },
        subagents: [
          {
            id: 'child',
            nickname: 'random-nickname',
            canonicalPosition: 'L2',
            state: 'idle',
            observedAt: now,
            lastActivityAt: now,
          },
        ],
      },
    });
    expect(screen.getByText('L2 — Current L2 title')).toBeTruthy();
    expect(screen.queryByText('random-nickname')).toBeNull();
  });
  it('uses the retained plan title for root, executor, and terminal-review labels', () => {
    const now = new Date().toISOString();
    render(AgentActivityIndicators, {
      plan: {
        title: 'Continuity plan',
        steps: [
          {
            id: 'one',
            title: 'First milestone',
            level: 1,
            state: 'WIP',
            priority: 'A',
            description: {},
            children: [],
          },
        ],
        totalSteps: 1,
        doneSteps: 0,
        allDone: false,
        currentStepId: 'one',
      },
      compact: true,
      activity: {
        sessionId: 's',
        confidence: 'fresh',
        aggregateSubagents: 'idle',
        root: { state: 'idle', observedAt: now, lastActivityAt: now },
        subagents: [
          {
            id: 'review',
            canonicalTaskName: 'final_review',
            state: 'idle',
            observedAt: now,
            lastActivityAt: now,
          },
          {
            id: 'executor',
            nickname: 'random',
            canonicalPosition: 'L1',
            continuationGeneration: 2,
            state: 'working',
            observedAt: now,
            lastActivityAt: now,
          },
        ],
      },
    });
    expect(screen.getByText('Supervisor — Continuity plan')).toBeTruthy();
    expect(screen.getByText('L1 — First milestone')).toBeTruthy();
    expect(screen.getByText('Final review — Continuity plan')).toBeTruthy();
    expect(screen.queryByText('random')).toBeNull();
  });
  it('keeps the canonical label when a plan title is missing, reordered, or appended', () => {
    const now = new Date().toISOString();
    const view = render(AgentActivityIndicators, {
      plan: {
        title: 'Plan',
        steps: [],
        totalSteps: 0,
        doneSteps: 0,
        allDone: false,
        currentStepId: '',
      },
      activity: {
        sessionId: 's',
        confidence: 'fresh',
        aggregateSubagents: 'idle',
        root: { state: 'idle', observedAt: now, lastActivityAt: now },
        subagents: [
          {
            id: 'child',
            nickname: 'random',
            canonicalPosition: 'L9',
            state: 'idle',
            observedAt: now,
            lastActivityAt: now,
          },
        ],
      },
    });
    expect(screen.getByText('L9 — title unavailable')).toBeTruthy();
    expect(screen.queryByText('random')).toBeNull();
    view.unmount();
  });
  it('reactively replaces an executor title after an appended plan update', async () => {
    const now = new Date().toISOString();
    const activity = {
      sessionId: 's',
      confidence: 'fresh' as const,
      aggregateSubagents: 'idle' as const,
      root: { state: 'idle' as const, observedAt: now, lastActivityAt: now },
      subagents: [
        {
          id: 'child',
          nickname: 'random',
          canonicalPosition: 'L2',
          state: 'idle' as const,
          observedAt: now,
          lastActivityAt: now,
        },
      ],
    };
    const base = {
      title: 'Plan',
      steps: [],
      totalSteps: 0,
      doneSteps: 0,
      allDone: false,
      currentStepId: '',
    };
    const view = render(AgentActivityIndicators, { activity, plan: base });
    expect(screen.getByText('L2 — title unavailable')).toBeTruthy();
    await view.rerender({
      activity,
      plan: {
        ...base,
        steps: [
          {
            id: 'one',
            title: 'First',
            level: 1 as const,
            state: 'TODO' as const,
            priority: 'A' as const,
            description: {},
            children: [],
          },
          {
            id: 'two',
            title: 'Appended title',
            level: 1 as const,
            state: 'WIP' as const,
            priority: 'A' as const,
            description: {},
            children: [],
          },
        ],
        totalSteps: 2,
        currentStepId: 'two',
      },
    });
    expect(screen.getByText('L2 — Appended title')).toBeTruthy();
    expect(screen.queryByText('random')).toBeNull();
  });
});

afterEach(cleanup);
