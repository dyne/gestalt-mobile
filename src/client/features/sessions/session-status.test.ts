/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { isSessionStatus } from './session-status.js';

const valid = {
  state: 'idle',
  reason: 'incompleteWithoutContinuation',
  confidence: 'fresh',
  observedAt: '2026-09-13T12:00:00.000Z',
  nextExpectedAction: 'Resume supervision.',
};

describe('isSessionStatus', () => {
  it('accepts the bounded server contract', () => expect(isSessionStatus(valid)).toBe(true));
  it.each([
    { ...valid, state: 'maybe' },
    { ...valid, reason: 'opaque-id' },
    { ...valid, confidence: 'optimistic' },
    { ...valid, observedAt: 'later' },
    { ...valid, nextExpectedAction: '' },
    { ...valid, nextExpectedAction: 'x'.repeat(241) },
  ])('rejects malformed legacy status safely', (value) =>
    expect(isSessionStatus(value)).toBe(false),
  );
});
