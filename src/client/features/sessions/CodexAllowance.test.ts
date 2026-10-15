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
  weeklyResetsAt: Math.floor(Date.now() / 1000) + 2 * 86_400,
  resetsAvailable: 2,
};

it('shows the remaining percentage, bar, days and reset credits', async () => {
  render(CodexAllowance, { fetcher: vi.fn(async () => Response.json(value)), onerror: vi.fn() });
  await screen.findByText('63% left');
  expect(
    screen.getByRole('progressbar', { name: 'Weekly allowance remaining' }).getAttribute('value'),
  ).toBe('63');
  expect(screen.getByText('Resets in 2 days')).toBeTruthy();
  expect(screen.getByText('2 available')).toBeTruthy();
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
