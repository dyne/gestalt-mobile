/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { formatLivenessElapsed } from './liveness.js';

describe('formatLivenessElapsed', () => {
  const updatedAt = '2026-08-31T12:00:00.000Z';

  it('formats elapsed activity entirely from supplied local time', () => {
    expect(formatLivenessElapsed(updatedAt, Date.parse(updatedAt) + 4_000)).toBe(
      'Updated just now',
    );
    expect(formatLivenessElapsed(updatedAt, Date.parse(updatedAt) + 23_000)).toBe(
      'Updated 23s ago',
    );
    expect(formatLivenessElapsed(updatedAt, Date.parse(updatedAt) + 121_000)).toBe(
      'Updated 2m ago',
    );
  });

  it('fails closed to a neutral label for malformed timestamps', () => {
    expect(formatLivenessElapsed('not-a-time', Date.now())).toBe('Updated recently');
  });
});
