/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  createPlanMeasurementSnapshot,
  totalThreadTokens,
  weeklyRateLimitWindow,
} from './measurement-snapshot.js';

describe('plan measurement snapshot', () => {
  it('selects the weekly rate-limit window by duration and derives remaining percentage', () => {
    const snapshot = createPlanMeasurementSnapshot({
      capturedAt: '2026-08-01T12:00:00Z',
      rateLimits: [
        { durationSeconds: 300, usedPercent: 10 },
        { durationSeconds: 60 * 60 * 24 * 7, usedPercent: 37 },
      ],
      tokenUsage: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 50 },
    });

    expect(snapshot).toEqual({
      capturedAt: '2026-08-01T12:00:00Z',
      weeklyRemainingPercent: 63,
      threadTokens: 200,
    });
  });

  it('accepts percentage boundaries and ignores malformed rate-limit windows', () => {
    expect(
      weeklyRateLimitWindow([
        { durationSeconds: 100, usedPercent: 101 },
        { durationSeconds: 200, usedPercent: 0 },
        { durationSeconds: 300, usedPercent: Number.NaN },
      ]),
    ).toEqual({ durationSeconds: 200, usedPercent: 0 });
    expect(
      createPlanMeasurementSnapshot({
        capturedAt: '2026-08-01T12:00:00Z',
        rateLimits: [{ durationSeconds: 60 * 60 * 24 * 7, usedPercent: 100 }],
      }).weeklyRemainingPercent,
    ).toBe(0);
  });

  it('keeps unavailable rate-limit and token data independent', () => {
    const snapshot = createPlanMeasurementSnapshot({
      capturedAt: '2026-08-01T12:00:00Z',
      tokenUsage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 },
    });
    expect(snapshot.weeklyRemainingPercent).toBeNull();
    expect(snapshot.threadTokens).toBe(6);

    expect(
      totalThreadTokens({ inputTokens: 1, cachedInputTokens: -1, outputTokens: 3 }),
    ).toBeNull();
    expect(totalThreadTokens(null)).toBeNull();
  });
});
