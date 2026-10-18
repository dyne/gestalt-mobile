/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import CodexAllowance from './CodexAllowance.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const value = {
  weeklyRemainingPercent: 63,
  weeklyResetsAt: Date.parse('2026-10-20T08:00:00Z') / 1000,
  resetsAvailable: 2,
};

it('shows the remaining percentage, bar, reset time and reset credits', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T08:00:00Z'));
  render(CodexAllowance, { fetcher: vi.fn(async () => Response.json(value)), onerror: vi.fn() });
  await screen.findByText('63% left');
  expect(
    screen.getByRole('progressbar', { name: 'Weekly allowance remaining' }).getAttribute('value'),
  ).toBe('63');
  expect(screen.getByText('Resets in 2 days')).toBeTruthy();
  expect(screen.getByText('2 available')).toBeTruthy();
});

it.each([
  [6 * 86_400 + 11 * 3_600, 'Resets in 6 days 11 hours'],
  [86_400 + 3_600, 'Resets in 1 day 1 hour'],
  [86_400, 'Resets in 1 day'],
  [23 * 3_600 + 59 * 60, 'Resets in 23 hours 59 minutes'],
  [3_600, 'Resets in 1 hour'],
  [61 * 60, 'Resets in 1 hour 1 minute'],
  [60, 'Resets in 1 minute'],
  [59, 'Resets in less than 1 minute'],
  [0, 'Reset due'],
  [-60, 'Reset due'],
])('formats a reset %i seconds away as %s', async (seconds, label) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T08:00:00Z'));
  const resetsAt = Date.now() / 1000 + seconds;
  render(CodexAllowance, {
    fetcher: vi.fn(async () => Response.json({ ...value, weeklyResetsAt: resetsAt })),
    onerror: vi.fn(),
  });
  const detail = await screen.findByText(label);
  expect(detail.getAttribute('title')).toBe(new Date(resetsAt * 1000).toLocaleString());
});

it('counts down and adopts a new reset timestamp on the next refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T08:00:00Z'));
  let resetsAt = Date.now() / 1000 + 6 * 86_400 + 11 * 3_600;
  const fetcher = vi.fn(async () => Response.json({ ...value, weeklyResetsAt: resetsAt }));
  render(CodexAllowance, { fetcher, onerror: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(screen.getByText('Resets in 6 days 11 hours')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(60_000);
  await tick();
  expect(screen.getByText('Resets in 6 days 10 hours')).toBeTruthy();
  resetsAt = Date.now() / 1000 + 7 * 86_400;
  await vi.advanceTimersByTimeAsync(60_000);
  await tick();
  expect(screen.getByText('Resets in 6 days 23 hours')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('distinguishes unavailable data from exhausted allowance and zero credits', async () => {
  render(CodexAllowance, {
    fetcher: vi.fn(async () =>
      Response.json({ weeklyRemainingPercent: null, weeklyResetsAt: null, resetsAvailable: 0 }),
    ),
    onerror: vi.fn(),
  });
  await screen.findByText('0 available');
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.getByText('Reset date unavailable')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('reports a failed read through the shared error callback', async () => {
  const onerror = vi.fn();
  render(CodexAllowance, {
    fetcher: vi.fn(async () => new Response('', { status: 503 })),
    onerror,
  });
  await waitFor(() => expect(onerror).toHaveBeenCalledOnce());
  expect(screen.getAllByText('Unavailable')).toHaveLength(2);
});

it('refreshes while mounted, clears stale data on failure and cancels work on unmount', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(value))
    .mockRejectedValue(new Error('offline'));
  const onerror = vi.fn();
  const view = render(CodexAllowance, { fetcher, onerror });
  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(screen.getByText('63% left')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(60_000);
  await tick();
  expect(screen.queryByRole('progressbar')).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(onerror).toHaveBeenCalledOnce();
  view.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
