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
  reason:
    | 'attentionRequired'
    | 'noPlanProgress'
    | 'reconcileFailed'
    | 'startUnavailable'
    | 'actionRateExceeded',
) => ({
  state: 'attentionRequired' as const,
  enabled: false,
  reason,
  retry: { position: 3, limit: 3 },
  updatedAt: '2026-08-20T00:00:00.000Z',
});

describe('AutopilotSafetyStop', () => {
  it('distinguishes an off-session provider failure from paused automatic work', () => {
    render(AutopilotSafetyStop, {
      autopilot: {
        ...safety('reconcileFailed'),
        state: 'disabled',
        reason: 'manualDisabled',
        providerFailure: { code: 'serverOverloaded' },
      },
      attention: null,
    });
    expect(screen.getByRole('alert', { name: 'Codex request failed' }).textContent).toContain(
      'Automatic supervision was not running',
    );
    expect(screen.queryByRole('button', { name: 'Retry Autopilot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
  it('explains the bounded pending retry and permits cancellation', () => {
    render(AutopilotSafetyStop, {
      autopilot: {
        ...safety('reconcileFailed'),
        state: 'safetyPaused',
        reason: 'providerError',
        providerFailure: { code: 'serverOverloaded' },
        providerRetry: {
          turnId: 'turn',
          attempt: 1,
          notBefore: '2026-10-19T00:00:30Z',
          settled: true,
          pending: true,
          resumeRoot: false,
        },
      },
      attention: null,
    });
    expect(screen.getByRole('alert').textContent).toContain('attempt 1 of 2');
    expect(
      (screen.getByRole('button', { name: 'Retry Autopilot' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Disable Autopilot' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps structured provider failure visible until supervision resumes', async () => {
    const { rerender } = render(AutopilotSafetyStop, {
      autopilot: {
        ...safety('reconcileFailed'),
        state: 'safetyPaused',
        reason: 'providerError',
        providerFailure: { code: 'httpConnectionFailed', httpStatusCode: 503 },
      },
      attention: null,
    });
    const alert = screen.getByRole('alert', { name: 'Codex execution paused' });
    expect(alert.textContent).toContain('httpConnectionFailed (HTTP 503)');
    expect(alert.textContent).toContain('provider HTTP connection failed');
    await rerender({
      autopilot: {
        ...safety('reconcileFailed'),
        state: 'monitoring',
        enabled: true,
        reason: undefined,
      },
      attention: null,
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('warns during enabled reconciliation recovery and clears when monitoring recovers', async () => {
    const onrecover = vi.fn();
    const ondisable = vi.fn();
    const { rerender } = render(AutopilotSafetyStop, {
      autopilot: { ...safety('reconcileFailed'), state: 'monitoring', enabled: true },
      attention: null,
      onrecover,
      ondisable,
    });
    expect(screen.getByRole('alert', { name: 'Autopilot recovery warning' }).textContent).toContain(
      'Autopilot cannot confirm agent status.',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Autopilot' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Disable Autopilot' }));
    expect(onrecover).toHaveBeenCalledOnce();
    expect(ondisable).toHaveBeenCalledOnce();
    await rerender({
      autopilot: {
        ...safety('reconcileFailed'),
        state: 'monitoring',
        enabled: true,
        reason: undefined,
      },
      attention: null,
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    'attentionRequired',
    'noPlanProgress',
    'reconcileFailed',
    'startUnavailable',
    'actionRateExceeded',
  ] as const)('presents %s with supported recovery and disable toggles', async (reason) => {
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
  });

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
