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
        'Session history could not be loaded from GET /api/sessions/:id/history. The relay is connected, but Codex has no active process for this session. Open the session to restore it, then retry.',
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
        'GET /api/sessions/:id/history reached the relay, but Codex could not read this session after recovery. This is not a connection failure. Open the session again; if it continues, inspect the running relay output.',
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
