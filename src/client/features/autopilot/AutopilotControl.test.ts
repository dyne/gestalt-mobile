/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AutopilotControl from './AutopilotControl.svelte';

afterEach(cleanup);
const snapshot = (
  state: 'disabled' | 'monitoring' | 'backoff' | 'attentionRequired' | 'completed',
) => ({
  state,
  enabled: state === 'monitoring' || state === 'backoff',
  retry: { position: 1, limit: 3 },
  updatedAt: '2026-08-20T00:00:00.000Z',
});

describe('AutopilotControl', () => {
  it('uses a named, 44px pressable control and reports state in text', async () => {
    const ontoggle = vi.fn();
    render(AutopilotControl, { autopilot: snapshot('monitoring'), ontoggle });
    const button = screen.getByRole('button', { name: 'Pause' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(button);
    expect(ontoggle).toHaveBeenCalledWith(false);
    expect(screen.getByText('Autopilot: Monitoring')).toBeTruthy();
  });
  it('keeps unavailable enablement focusable and explains why', () => {
    render(AutopilotControl, { autopilot: { ...snapshot('disabled'), reason: 'planRequired' } });
    const button = screen.getByRole('button', { name: 'Enable' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText('An incomplete supervised plan is required before Autopilot can start.'),
    ).toBeTruthy();
  });
  it('allows a manually paused session to enable again', async () => {
    const ontoggle = vi.fn();
    render(AutopilotControl, {
      autopilot: { ...snapshot('disabled'), reason: 'manualDisabled' },
      ontoggle,
    });
    const button = screen.getByRole('button', { name: 'Enable' });
    expect(button.getAttribute('aria-disabled')).toBe('false');
    await fireEvent.click(button);
    expect(ontoggle).toHaveBeenCalledWith(true);
  });
  it.each(['disabled', 'monitoring', 'backoff', 'attentionRequired', 'completed'] as const)(
    'renders %s without color-only status',
    (state) => {
      render(AutopilotControl, { autopilot: snapshot(state) });
      expect(screen.getByText(/Autopilot:/).textContent).toBeTruthy();
    },
  );
  it('does not mislabel a known attention-required state as loading', () => {
    render(AutopilotControl, { autopilot: snapshot('attentionRequired') });
    expect(screen.getByText('Autopilot is paused for a pending attention request.')).toBeTruthy();
  });
  it('does not invent retry progress while monitoring and exposes a dedicated polite status', () => {
    render(AutopilotControl, {
      autopilot: { ...snapshot('monitoring'), retry: { position: 0, limit: 3 } },
    });
    expect(screen.queryByText(/Retry 0/)).toBeNull();
    const liveStatus = screen.getByTestId('autopilot-live-status');
    expect(liveStatus.getAttribute('aria-live')).toBe('polite');
    expect(liveStatus.getAttribute('aria-atomic')).toBe('true');
    expect(liveStatus.textContent).toContain('Autopilot status: Monitoring.');
    expect(liveStatus.textContent).toContain('Autopilot is monitoring this supervised plan.');
  });
  it('reports retry progress only for a real nonzero backoff', () => {
    render(AutopilotControl, {
      autopilot: { ...snapshot('backoff'), retry: { position: 2, limit: 3 } },
    });
    expect(screen.getByText('Retry 2 of 3.')).toBeTruthy();
    expect(screen.getByTestId('autopilot-live-status').textContent).toContain('Retry 2 of 3.');
  });
});
