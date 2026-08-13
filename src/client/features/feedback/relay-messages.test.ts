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

  it('maps a stable API problem code without exposing its detail', () =>
    expect(
      relayFeedback(
        Object.assign(new Error('unsafe server detail'), { code: 'SESSION_HISTORY_UNAVAILABLE' }),
        'RELAY_UNAVAILABLE',
      ),
    ).toEqual({
      code: 'SESSION_HISTORY_UNAVAILABLE',
      message:
        'Session history is unavailable. Check the relay connection and try opening the session again.',
    }));

  it('explains a Codex history read failure as distinct from a relay outage', () =>
    expect(
      relayFeedback(
        Object.assign(new Error('unsafe server detail'), { code: 'SESSION_HISTORY_READ_FAILED' }),
        'RELAY_UNAVAILABLE',
      ),
    ).toEqual({
      code: 'SESSION_HISTORY_READ_FAILED',
      message:
        'Session history could not be read. The conversation remains saved; try again shortly.',
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
