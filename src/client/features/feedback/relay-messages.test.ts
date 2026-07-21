/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { relayFeedback } from './relay-messages.js';

describe('relayFeedback', () => {
  it('maps a recognized stable code', () =>
    expect(relayFeedback(new Error('GIT_CLONE_FAILED'), 'RELAY_UNAVAILABLE')).toEqual({
      code: 'GIT_CLONE_FAILED',
      message: 'Clone failed.',
    }));

  it('never exposes arbitrary error details', () => {
    const feedback = relayFeedback(
      new Error('secret token and generated model output'),
      'RELAY_UNAVAILABLE',
    );
    expect(feedback.code).toBe('RELAY_UNAVAILABLE');
    expect(feedback.message).not.toContain('secret');
    expect(feedback.message).not.toContain('output');
  });
});
