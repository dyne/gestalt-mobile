/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppHeader from './AppHeader.svelte';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(cleanup);

describe('AppHeader', () => {
  it('shows root-wide indexing progress and durable recovery guidance', async () => {
    const props = { theme: 'dyne-org' as const, onthemechange: () => {} };
    const { rerender } = render(AppHeader, {
      ...props,
      xerj: {
        mode: 'auto',
        state: 'indexing',
        root: '/sources/engineering',
        phase: 'index',
        percent: 42,
      },
    });
    const status = screen.getByRole('region', { name: 'Source discovery', hidden: true });
    expect(status.textContent).toContain('/sources/engineering');
    expect(status.textContent).toContain('42%');
    await rerender({
      ...props,
      xerj: {
        mode: 'auto',
        state: 'watching',
        root: '/sources/engineering',
        files: 300,
        records: 500,
      },
    });
    expect(status.textContent).toContain('watching');
    expect(status.textContent).toContain('300');
    expect(status.textContent).not.toContain('42%');
    await rerender({
      ...props,
      xerj: {
        mode: 'auto',
        state: 'error',
        root: '/sources/engineering',
        message: 'Run gestalt doctor.',
      },
    });
    expect(status.textContent).toContain('Run gestalt doctor.');
  });

  it('adds and removes the contextual CLI copy action and closes the menu after copying', async () => {
    const oncopytocli = vi.fn();
    const props = { theme: 'dyne-org' as const, onthemechange: () => {} };
    const { rerender } = render(AppHeader, props);
    expect(screen.queryByRole('button', { name: 'Copy session to CLI', hidden: true })).toBeNull();
    await rerender({ ...props, oncopytocli });
    const action = screen.getByRole('button', { name: 'Copy session to CLI', hidden: true });
    expect(action.getAttribute('popovertargetaction')).toBe('hide');
    await fireEvent.click(action);
    expect(oncopytocli).toHaveBeenCalledOnce();
    await rerender({ ...props, oncopytocli: undefined });
    expect(screen.queryByRole('button', { name: 'Copy session to CLI', hidden: true })).toBeNull();
  });

  it('keeps contextual copying unavailable when a session has no CLI command', () => {
    render(AppHeader, {
      theme: 'dyne-org',
      onthemechange: () => {},
      oncopytocli: vi.fn(),
      copyToCliAvailable: false,
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'Copy session to CLI',
          hidden: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('renders supplied contextual actions and closes the popover when invoked', async () => {
    const run = vi.fn();
    render(AppHeader, {
      theme: 'dyne-org',
      onthemechange: () => {},
      contextualActions: [{ id: 'debug', label: 'DEBUG', run }],
    });
    const debug = screen.getByRole('button', { name: 'DEBUG', hidden: true });
    expect(debug.getAttribute('popovertargetaction')).toBe('hide');
    await fireEvent.click(debug);
    expect(run).toHaveBeenCalledOnce();
  });
  it('substitutes a configured install icon while preserving the Gestalt logotype', () => {
    const { container } = render(AppHeader, {
      theme: 'dyne-org',
      brandIconUrl: '/install-icon.svg',
      onthemechange: () => {},
    });

    expect(container.querySelectorAll('.brand-icon')).toHaveLength(1);
    expect(container.querySelector('.brand-icon-custom')?.getAttribute('src')).toBe(
      '/install-icon.svg',
    );
    expect(container.querySelectorAll('.brand-logotype')).toHaveLength(2);
    expect(container.querySelector('[src="/branding/p_glogo_grey.svg"]')).toBeNull();
  });

  it('keeps the theme-specific Gestalt symbol when no install icon is configured', () => {
    const { container } = render(AppHeader, {
      theme: 'dyne-org',
      onthemechange: () => {},
    });

    expect(container.querySelectorAll('.brand-icon')).toHaveLength(2);
    expect(container.querySelector('.brand-icon-custom')).toBeNull();
  });

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

  it('opens recent notifications from the burger popover', async () => {
    const onnotifications = vi.fn();
    render(AppHeader, { theme: 'dyne-org', onthemechange: () => {}, onnotifications });
    const action = screen.getByRole('button', { name: 'Notifications', hidden: true });
    expect(action.getAttribute('popovertargetaction')).toBe('hide');
    await fireEvent.click(action);
    expect(onnotifications).toHaveBeenCalledOnce();
  });

  it('lists exact running component versions in the burger popover', () => {
    render(AppHeader, {
      theme: 'dyne-org',
      onthemechange: () => {},
      componentVersions: [
        { id: 'gestalt', label: 'Gestalt manager', version: '0.1.0' },
        { id: 'gestalt-mobile', label: 'Gestalt Mobile', version: '0.33.0' },
        { id: 'gestalt-agents', label: 'Gestalt Agents', version: '2.9.0' },
        { id: 'context-mode', label: 'Context Mode', version: '2.9.0' },
        { id: 'codex', label: 'Codex CLI', version: 'codex-cli 0.144.3' },
        { id: 'xerj', label: 'xerj', version: 'v1.0.0-rc.87' },
        { id: 'serena', label: 'Serena', version: '1.7.0' },
        { id: 'uv', label: 'uv', version: '0.11.12' },
        { id: 'serena-python', label: 'Serena Python', version: null },
      ],
    });

    const versions = screen.getByRole('region', { name: 'Versions', hidden: true });
    expect(
      [...versions.querySelectorAll('dl > div')].map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent?.trim(),
      ]),
    ).toEqual([
      ['Gestalt manager', '0.1.0'],
      ['Gestalt Mobile', '0.33.0'],
      ['Gestalt Agents', '2.9.0'],
      ['Context Mode', '2.9.0'],
      ['Codex CLI', 'codex-cli 0.144.3'],
      ['xerj', 'v1.0.0-rc.87'],
      ['Serena', '1.7.0'],
      ['uv', '0.11.12'],
      ['Serena Python', 'Unavailable'],
    ]);
  });

  it('requires confirmation before quitting the relay', async () => {
    const onquit = vi.fn(async () => undefined);
    render(AppHeader, { theme: 'dyne-org', onthemechange: () => {}, onquit });

    const menu = document.getElementById('configuration-panel')!;
    await fireEvent.click(within(menu).getByRole('button', { name: 'Quit', hidden: true }));

    const dialog = screen.getByRole('dialog', { name: 'Quit Gestalt Mobile?' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(onquit).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await Promise.resolve();
    expect(document.activeElement).toBe(cancel);
    await fireEvent.click(cancel);
    await Promise.resolve();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(onquit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open configuration' })).toBe(document.activeElement);

    await fireEvent.click(within(menu).getByRole('button', { name: 'Quit', hidden: true }));
    await fireEvent.click(dialog.querySelector<HTMLButtonElement>('.confirm-quit')!);

    expect(onquit).toHaveBeenCalledOnce();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Quitting…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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
