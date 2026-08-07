/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BottomNavigation from './BottomNavigation.svelte';

afterEach(cleanup);

describe('BottomNavigation', () => {
  it('renders Plan directly after Chat regardless of retained-plan availability', () => {
    render(BottomNavigation, {
      activeTab: 'chat',
      chatEnabled: true,
      onselect: vi.fn(),
    });
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
      'Sessions',
      'Git',
      'Chat',
      'Plan',
    ]);
  });

  it('keeps pointer and arrow navigation in the visible order', async () => {
    const onselect = vi.fn();
    render(BottomNavigation, {
      activeTab: 'chat',
      chatEnabled: true,
      onselect,
    });
    const chat = screen.getByRole('button', { name: 'Chat' });
    const plan = screen.getByRole('button', { name: 'Plan' });

    await fireEvent.click(plan);
    expect(onselect).toHaveBeenLastCalledWith('plan');

    chat.focus();
    await fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(onselect).toHaveBeenLastCalledWith('plan');
    expect(document.activeElement).toBe(plan);
  });
});
