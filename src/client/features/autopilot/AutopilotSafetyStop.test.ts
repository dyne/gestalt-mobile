/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AutopilotSafetyStop from './AutopilotSafetyStop.svelte';

afterEach(cleanup);
const safety = (
  reason: 'attentionRequired' | 'noPlanProgress' | 'reconcileFailed' | 'startUnavailable',
) => ({
  state: 'attentionRequired' as const,
  enabled: false,
  reason,
  retry: { position: 3, limit: 3 },
  updatedAt: '2026-08-20T00:00:00.000Z',
});

describe('AutopilotSafetyStop', () => {
  it.each(['attentionRequired', 'noPlanProgress', 'reconcileFailed', 'startUnavailable'] as const)(
    'presents %s with supported recovery and disable toggles',
    async (reason) => {
      const onrecover = vi.fn();
      const ondisable = vi.fn();
      render(AutopilotSafetyStop, {
        autopilot: safety(reason),
        attention: null,
        onrecover,
        ondisable,
      });
      expect(screen.getByRole('alert').textContent).toContain(
        'There is no pending agent attention request',
      );
      await fireEvent.click(screen.getByRole('button', { name: 'Retry Autopilot' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Disable Autopilot' }));
      expect(onrecover).toHaveBeenCalledOnce();
      expect(ondisable).toHaveBeenCalledOnce();
    },
  );

  it('does not replace a tool-declared attention alert', () => {
    render(AutopilotSafetyStop, {
      autopilot: safety('noPlanProgress'),
      attention: {
        requestId: 'r',
        turnId: null,
        requestedAt: null,
        attention: {
          reason: 'hardBlock',
          summary: 'x',
          requestedAction: 'x',
          resumeCondition: 'x',
        },
      },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives runtime recovery guidance without claiming there is a request to resolve', () => {
    render(AutopilotSafetyStop, {
      autopilot: safety('startUnavailable'),
      attention: null,
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Restore or reopen this session, then retry Autopilot.',
    );
    expect(screen.getByRole('alert').textContent).not.toContain('request is resolved');
  });
});
