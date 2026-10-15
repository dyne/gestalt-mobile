/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAllowanceReader, decodeCodexAllowance } from './codex-allowance.js';

const weekly = { windowDurationMins: 10_080, usedPercent: 37, resetsAt: 1_800_000_000 };
const response = {
  rateLimits: { secondary: weekly },
  rateLimitResetCredits: { availableCount: 3, credits: [] },
};
afterEach(() => vi.useRealTimers());

describe('Codex allowance', () => {
  it('reads the weekly window by duration and uses the authoritative reset count', () => {
    expect(decodeCodexAllowance(response)).toEqual({
      weeklyRemainingPercent: 63,
      weeklyResetsAt: weekly.resetsAt,
      resetsAvailable: 3,
    });
    expect(decodeCodexAllowance({ rateLimits: { primary: weekly } }).weeklyRemainingPercent).toBe(
      63,
    );
  });
  it('prefers the Codex bucket over a different metered bucket', () => {
    expect(
      decodeCodexAllowance({ rateLimits: { limitId: 'codex_other', primary: weekly } })
        .weeklyRemainingPercent,
    ).toBeNull();
    expect(
      decodeCodexAllowance({
        ...response,
        rateLimitsByLimitId: { codex: { primary: { ...weekly, usedPercent: 100 } } },
      }).weeklyRemainingPercent,
    ).toBe(0);
  });
  it.each([
    null,
    {},
    { rateLimits: { secondary: { windowDurationMins: 300, usedPercent: 20 } } },
    {
      rateLimits: { secondary: { ...weekly, usedPercent: '37' } },
      rateLimitResetCredits: { availableCount: -1 },
    },
  ])('does not invent counters for unavailable or malformed data', (value) => {
    expect(decodeCodexAllowance(value)).toEqual({
      weeklyRemainingPercent: null,
      weeklyResetsAt: null,
      resetsAvailable: null,
    });
  });
  it('preserves zero credits and clamps a depleted allowance', () => {
    expect(
      decodeCodexAllowance({
        rateLimits: { primary: { ...weekly, usedPercent: 110, resetsAt: 'invalid' } },
        rateLimitResetCredits: { availableCount: 0 },
      }),
    ).toEqual({ weeklyRemainingPercent: 0, weeklyResetsAt: null, resetsAvailable: 0 });
  });
  it('shares concurrent reads, caches briefly, closes the reader and only calls read APIs', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => (method === 'initialize' ? {} : response));
    const close = vi.fn();
    const launch = vi.fn(() => ({ rpc: { request }, close }));
    const reader = new CodexAllowanceReader('/workspace', launch);
    const values = await Promise.all([reader.read(), reader.read()]);
    expect(values[0]).toEqual(values[1]);
    await reader.read();
    expect(launch).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'account/rateLimits/read',
    ]);
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    await reader.read();
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('closes timed-out readers and allows a subsequent attempt', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(response);
    const close = vi.fn();
    const reader = new CodexAllowanceReader('/workspace', () => ({ rpc: { request }, close }), 100);
    const failed = expect(reader.read()).rejects.toThrow('CODEX_ALLOWANCE_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(close).toHaveBeenCalledOnce();
    expect((await reader.read()).weeklyRemainingPercent).toBe(63);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
