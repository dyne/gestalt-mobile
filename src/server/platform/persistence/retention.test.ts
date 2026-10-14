/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { eventRetentionCutoff, eventRetentionMs } from './retention.js';
describe('event retention', () => {
  it('defaults to 48 hours independent of event volume', () => {
    expect(eventRetentionMs).toBe(172_800_000);
    expect(eventRetentionCutoff('2026-10-14T12:00:00.000Z')).toBe('2026-10-12T12:00:00.000Z');
    expect(eventRetentionCutoff('2026-10-14T14:00:00+02:00')).toBe('2026-10-12T12:00:00.000Z');
  });
  it('does not expire evidence using an invalid timestamp', () => {
    expect(eventRetentionCutoff('invalid')).toBeNull();
  });
});
