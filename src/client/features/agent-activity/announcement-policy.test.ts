/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, expect, it } from 'vitest';
import { activityAnnouncement } from './announcement-policy.js';
const value = (state = 'working') => ({
  sessionId: 's',
  confidence: 'fresh' as const,
  aggregateSubagents: 'idle' as const,
  root: {
    state: state as 'working' | 'blocked',
    observedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  },
  subagents: [],
});
describe('activityAnnouncement', () => {
  it('ignores heartbeat timestamps and dedupes critical state', () => {
    expect(
      activityAnnouncement(value(), {
        ...value(),
        root: { ...value().root, observedAt: '2026-01-02T00:00:00.000Z' },
      }),
    ).toEqual({ polite: '', critical: '' });
    expect(activityAnnouncement(value(), value('blocked')).critical).toContain('blocked');
    expect(activityAnnouncement(value('blocked'), value('blocked')).critical).toBe('');
  });
});
