/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './relative-time.js';

describe('formatRelativeTime', () => {
  it('formats elapsed time as compact human-readable hours and days', () => {
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);

    expect(formatRelativeTime(now - 2 * 60 * 60 * 1000, now)).toBe('2 hours ago');
    expect(formatRelativeTime(now - 24 * 60 * 60 * 1000, now)).toBe('1 day ago');
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, now)).toBe('3 days ago');
  });
});
