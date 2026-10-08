/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { normalizeCodexNotification } from '../../../server/platform/codex/normalizer.js';
import { serenaAvailabilityFeedback } from './serena-feedback.js';

describe('session Serena availability feedback', () => {
  it.each(['failed', 'cancelled'])(
    'routes %s through bounded existing activity and warning channels',
    (status) => {
      const event = normalizeCodexNotification(
        'session',
        1,
        't',
        {
          method: 'mcpServer/statusUpdated',
          params: { name: 'gestalt-serena', status, error: 'private token=secret' },
        },
        '/session',
        'turn',
      );
      expect(event).toMatchObject({
        type: 'activity.updated',
        payload: { label: 'Serena unavailable', turnId: 'turn' },
      });
      expect(serenaAvailabilityFeedback(event!)).toMatchObject({
        kind: 'warning',
        code: 'SERENA_UNAVAILABLE',
      });
      expect(JSON.stringify(event)).not.toContain('secret');
      expect(JSON.stringify(serenaAvailabilityFeedback(event!))).not.toContain('secret');
    },
  );
  it('reports connection separately from language readiness without a failure warning', () => {
    const event = normalizeCodexNotification('session', 1, 't', {
      method: 'mcpServer/statusUpdated',
      params: { name: 'gestalt-serena', status: 'connected' },
    });
    expect(event?.payload).toMatchObject({
      label: 'Serena connected',
      detail: expect.stringContaining('language readiness is still unverified'),
    });
    expect(serenaAvailabilityFeedback(event!)).toBeNull();
  });
  it('does not turn unrelated activity or raw details into Serena warnings', () => {
    for (const event of [
      { type: 'other', payload: {} },
      { type: 'activity.updated', payload: null },
      { type: 'activity.updated', payload: { id: 'other', label: 'Serena unavailable' } },
    ])
      expect(serenaAvailabilityFeedback(event)).toBeNull();
    expect(
      serenaAvailabilityFeedback({
        type: 'activity.updated',
        payload: {
          id: 'gestalt-serena-availability',
          label: 'Serena unavailable',
          detail: 'secret',
        },
      })?.message,
    ).not.toContain('secret');
  });
});
