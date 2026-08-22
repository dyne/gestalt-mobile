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
            state: 'idle',
            observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
            lastActivityAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          },
        ],
      },
    });

    expect(screen.getByText('Agents (2)')).toBeTruthy();
    expect(screen.queryByText('Current')).toBeNull();
    expect(screen.getByText('Root agent')).toBeTruthy();
    expect(screen.getByText('Worker')).toBeTruthy();
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
});

afterEach(cleanup);
