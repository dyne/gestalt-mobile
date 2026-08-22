/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { compactElapsedTime } from './relative-activity-time.js';

const now = Date.parse('2026-08-22T12:00:00.000Z');

describe('compactElapsedTime', () => {
  it.each([
    ['2026-08-22T11:59:45.000Z', '<1m'],
    ['2026-08-22T11:58:00.000Z', '2m'],
    ['2026-08-22T10:00:00.000Z', '2h'],
    ['2026-08-20T12:00:00.000Z', '2d'],
    ['2026-08-01T12:00:00.000Z', '3w'],
    ['2026-06-22T12:00:00.000Z', '2mo'],
    ['2025-08-22T12:00:00.000Z', '1y'],
  ])('formats %s as %s', (occurredAt, expected) => {
    expect(compactElapsedTime(occurredAt, now)).toBe(expected);
  });

  it('handles invalid and future activity safely', () => {
    expect(compactElapsedTime('invalid', now)).toBe('recently');
    expect(compactElapsedTime('2026-08-22T12:01:00.000Z', now)).toBe('<1m');
  });
});
