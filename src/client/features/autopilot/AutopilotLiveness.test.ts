/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutopilotLiveness from './AutopilotLiveness.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const snapshot = (state: 'monitoring' | 'backoff' | 'attentionRequired' | 'safetyPaused') => ({
  state,
  enabled: state === 'monitoring' || state === 'backoff',
  retry: { position: 0, limit: 3 },
  updatedAt: '2026-08-31T12:00:00.000Z',
});

describe('AutopilotLiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:08.000Z'));
  });

  it('renders active liveness and advances its local elapsed label without relay work', async () => {
    render(AutopilotLiveness, { autopilot: snapshot('monitoring') });
    const status = screen.getByRole('status', { name: /monitoring active/i });
    expect(status.classList.contains('active')).toBe(true);
    expect(status.textContent).toContain('Updated 8s ago');
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(status.textContent).toContain('Updated 10s ago');
  });

  it('stops local clock motion while hidden and refreshes it when visible again', async () => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    render(AutopilotLiveness, { autopilot: snapshot('backoff') });
    const status = screen.getByRole('status');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    vi.advanceTimersByTime(4_000);
    await tick();
    expect(status.textContent).toContain('Updated 8s ago');
    visibility = 'visible';
    vi.setSystemTime(new Date('2026-08-31T12:00:12.000Z'));
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(status.textContent).toContain('Updated 12s ago');
  });

  it.each([
    ['attentionRequired', 'Monitoring needs attention'],
    ['safetyPaused', 'Monitoring safety paused'],
  ] as const)('distinguishes %s in accessible text without active motion', (state, label) => {
    render(AutopilotLiveness, { autopilot: snapshot(state) });
    const status = screen.getByRole('status', { name: label });
    expect(status.classList.contains('active')).toBe(false);
    expect(status.getAttribute('data-state')).toBe(state);
  });

  it('makes disconnection explicit and local', () => {
    render(AutopilotLiveness, { autopilot: snapshot('monitoring'), connected: false });
    expect(screen.getByRole('status', { name: 'Monitoring disconnected' })).toBeTruthy();
  });
});
