/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { formatElapsedAfter, formatRelativeAge } from './message-time.js';

describe('formatElapsedAfter', () => {
  it('formats a compact elapsed time after the preceding message', () => {
    const start = Date.UTC(2026, 6, 15, 12, 0, 0);
    expect(formatElapsedAfter(start, start + 1_000)).toBe('moments later');
    expect(formatElapsedAfter(start, start + 2 * 60 * 1000)).toBe('2 minutes later');
    expect(formatElapsedAfter(start, start + 30 * 60 * 1000)).toBe('30 minutes later');
    expect(formatElapsedAfter(start, start + 2 * 60 * 60 * 1000)).toBe('2 hours later');
    expect(formatElapsedAfter(start, start + 3 * 24 * 60 * 60 * 1000)).toBe('3 days later');
    expect(formatElapsedAfter(start, start - 1_000)).toBe('moments later');
    expect(formatElapsedAfter(start, Number.NaN)).toBeNull();
  });
});

describe('formatRelativeAge', () => {
  it('formats a compact human age from seconds through days', () => {
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    expect(formatRelativeAge(now - 1_000, now)).toBe('1s ago');
    expect(formatRelativeAge(now - 3 * 60_000, now)).toBe('3m ago');
    expect(formatRelativeAge(now - 2 * 60 * 60_000, now)).toBe('2h ago');
    expect(formatRelativeAge(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
});
