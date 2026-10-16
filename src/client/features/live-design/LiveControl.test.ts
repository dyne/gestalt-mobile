/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveControl from './LiveControl.svelte';
import type { LiveClient } from './contracts.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function showPanel(): Promise<void> {
  await fireEvent(
    document.querySelector('[popover]')!,
    Object.assign(new Event('toggle'), { newState: 'open' }),
  );
}
const fixture = () =>
  ({
    liveTargets: vi.fn(async () => ({ targets: [{ appId: 'app', targetId: 'web' }] })),
    liveStatus: vi.fn(() => Promise.reject(Object.assign(new Error(), { code: 'LIVE_NOT_FOUND' }))),
    liveStart: vi.fn(async () => ({ liveId: 'live', generation: 1, state: 'active' })),
    liveLaunch: vi.fn(),
  }) satisfies LiveClient;

describe('Live controls', () => {
  it('offers the registered app and announces the starting transition', async () => {
    const client = fixture();
    client.liveStart = vi.fn(() => new Promise(() => {}));
    render(LiveControl, { client, relayId: 'relay', notify: vi.fn() });
    await showPanel();
    const start = await screen.findByRole('button', { name: 'Start Live', hidden: true });
    await vi.waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByLabelText('Registered app').textContent).toContain('app · web');
    await fireEvent.click(start);
    expect(
      screen
        .getByRole('button', { name: 'Starting Live…', hidden: true })
        .getAttribute('aria-busy'),
    ).toBe('true');
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain('Starting Live');
  });

  it('keeps a blocked popup actionable without rendering grants or links', async () => {
    const client: LiveClient = {
      ...fixture(),
      liveStatus: vi.fn(async () => ({ liveId: 'live', generation: 1, state: 'active' })),
    };
    const notify = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(LiveControl, { client, relayId: 'relay', notify });
    await showPanel();
    const open = await screen.findByRole('button', { name: 'Open preview', hidden: true });
    await fireEvent.click(open);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    expect(client.liveLaunch).not.toHaveBeenCalled();
    expect(document.querySelector('a')).toBeNull();
    expect(screen.getByText(/Allow pop-ups for Mobile in your browser/)).toBeTruthy();
  });

  it('explains unsupported providers and disables Start', async () => {
    render(LiveControl, { client: fixture(), relayId: 'relay', provider: 'kimi', notify: vi.fn() });
    await vi.waitFor(() =>
      expect(screen.getByRole('status', { hidden: true }).textContent).toContain('Codex'),
    );
    expect(
      (screen.getByRole('button', { name: 'Start Live', hidden: true }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
