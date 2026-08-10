/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AppHeader from './AppHeader.svelte';

afterEach(cleanup);

describe('AppHeader', () => {
  it('keeps the session model as separately spaced header metadata', () => {
    const { container } = render(AppHeader, {
      theme: 'dyne-org',
      sessionPath: '/workspace/gestalt-mobile',
      sessionModel: 'gpt-5.6-terra',
      onthemechange: () => {},
    });

    expect(container.querySelector('.session-model')?.textContent).toBe('· gpt-5.6-terra');
  });

  it('places the available weekly quota remaining immediately before the menu trigger', () => {
    const { container } = render(AppHeader, {
      theme: 'dyne-org',
      weeklyQuotaRemaining: 63,
      onthemechange: () => {},
    });

    expect(container.querySelector('.weekly-quota')?.textContent).toBe('63% left');
    expect(container.querySelector('.weekly-quota + .menu-trigger')).toBeTruthy();
  });

  it('omits the weekly quota when the relay has no current value', () => {
    const { container } = render(AppHeader, { theme: 'dyne-org', onthemechange: () => {} });

    expect(container.querySelector('.weekly-quota')).toBeNull();
  });

  it('offers the exact named lock action in the configuration popover', async () => {
    const onlock = vi.fn();
    render(AppHeader, { theme: 'dyne-org', onthemechange: () => {}, onlock });
    const action = screen.getByRole('button', { name: 'Lock Gestalt Mobile', hidden: true });
    expect(action.getAttribute('popovertargetaction')).toBe('hide');
    await fireEvent.click(action);
    expect(onlock).toHaveBeenCalledOnce();
  });

  it('opens the named authorized-devices route from the burger popover', async () => {
    const ondevices = vi.fn();
    render(AppHeader, { theme: 'dyne-org', onthemechange: () => {}, ondevices });
    const action = screen.getByRole('button', { name: 'Authorized devices', hidden: true });
    await fireEvent.click(action);
    expect(ondevices).toHaveBeenCalledWith(action);
  });

  it('opens the scratchpad from the burger popover', async () => {
    const onscratchpad = vi.fn();
    render(AppHeader, { theme: 'dyne-org', onthemechange: () => {}, onscratchpad });
    const action = screen.getByRole('button', { name: 'Scratchpad', hidden: true });
    expect(action.getAttribute('popovertargetaction')).toBe('hide');
    await fireEvent.click(action);
    expect(onscratchpad).toHaveBeenCalledOnce();
  });

  it('omits passkey-only actions when passkey access control is disabled', () => {
    render(AppHeader, {
      theme: 'dyne-org',
      passkeyAuthEnabled: false,
      onthemechange: () => {},
    });

    expect(screen.queryByRole('button', { name: 'Authorized devices', hidden: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock Gestalt Mobile', hidden: true })).toBeNull();
  });

  it('renders the registry options in stable order and reports their stable IDs', async () => {
    const onthemechange = vi.fn();
    render(AppHeader, { theme: 'minimal-light', onthemechange });
    const appearance = screen.getByRole('combobox', {
      name: 'Appearance',
      hidden: true,
    }) as HTMLSelectElement;
    expect([...appearance.options].map((option) => [option.value, option.text])).toEqual([
      ['dyne-org', 'Dyne.org'],
      ['minimal-light', 'Minimal light'],
      ['minimal-dark', 'Minimal dark'],
    ]);
    expect(appearance.value).toBe('minimal-light');
    await fireEvent.change(appearance, { target: { value: 'minimal-dark' } });
    expect(onthemechange).toHaveBeenCalledWith('minimal-dark');
  });
});
