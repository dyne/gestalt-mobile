/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeDeadline, capabilityDeadline } from './capability-deadline.js';

afterEach(() => vi.useRealTimers());

describe('shared capability deadlines', () => {
  it.each([
    [undefined, 5_000],
    ['100', 100],
    ['60000', 60_000],
    ['99', 5_000],
    ['60001', 5_000],
    ['100.5', 5_000],
    ['invalid', 5_000],
  ])('preserves the existing timeout setting %s', (configured, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    expect(
      capabilityDeadline(configured === undefined ? {} : { XERJ_READY_TIMEOUT_MS: configured }),
    ).toBe(100_000 + expected);
  });

  it('preserves a completed result and cancels its deadline timer', async () => {
    vi.useFakeTimers();
    const result = { ready: true };
    await expect(beforeDeadline(Promise.resolve(result), Date.now() + 100)).resolves.toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an upstream failure and cancels its deadline timer', async () => {
    vi.useFakeTimers();
    const failure = new Error('NATIVE_CONFIG_UNAVAILABLE');
    await expect(beforeDeadline(Promise.reject(failure), Date.now() + 100)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 100])('bounds a stalled operation with %sms remaining', async (remaining) => {
    vi.useFakeTimers();
    const result = beforeDeadline(new Promise<never>(() => {}), Date.now() + remaining);
    const rejected = expect(result).rejects.toThrow('XERJ_READINESS_TIMEOUT');
    await vi.advanceTimersByTimeAsync(remaining);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
