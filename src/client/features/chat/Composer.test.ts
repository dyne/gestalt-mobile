/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';

afterEach(cleanup);

describe('Composer', () => {
  it('separates the ready label from its cursor', () => {
    render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange: () => {},
      onsend: () => {},
      oninterrupt: () => {},
    });

    const status = screen.getByRole('status', { name: 'Ready.' });
    expect(status.firstChild?.textContent).toBe('Ready ');
  });

  it('shows and accepts compact command completion above the prompt', async () => {
    const onchange = vi.fn();
    const onsend = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange,
      onsend,
      oninterrupt: () => {},
    });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    await fireEvent.input(prompt, { target: { value: '/' } });
    expect(onchange).toHaveBeenLastCalledWith('/');
    rerender({
      status: 'Ready.',
      message: '/',
      activeTurnId: null,
      starting: false,
      onchange,
      onsend,
      oninterrupt: () => {},
    });
    expect(screen.getByLabelText('Chat commands').textContent).toContain('/model');

    await fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: false });
    expect(onchange).toHaveBeenLastCalledWith('/model ');
    expect(onsend).not.toHaveBeenCalled();
  });

  it('does not request a bottom scroll while typing but does after accepting a completion', async () => {
    const onchange = vi.fn();
    const onscrollbottom = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange,
      onscrollbottom,
      onsend: () => {},
      oninterrupt: () => {},
    });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    await fireEvent.input(prompt, { target: { value: '/' } });
    expect(onscrollbottom).not.toHaveBeenCalled();
    rerender({
      status: 'Ready.',
      message: '/',
      activeTurnId: null,
      starting: false,
      onchange,
      onscrollbottom,
      onsend: () => {},
      oninterrupt: () => {},
    });

    await fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: false });
    expect(onscrollbottom).toHaveBeenCalledTimes(1);
  });

  it('keeps models visible after command completion and sorts newest first', async () => {
    const onmodelselect = vi.fn();
    const onscrollbottom = vi.fn();
    render(Composer, {
      status: 'Ready.',
      message: '/model ',
      activeTurnId: null,
      starting: false,
      models: ['gpt-5.4', 'gpt-5.6-terra'],
      onchange: () => {},
      onmodelselect,
      onscrollbottom,
      onsend: () => {},
      oninterrupt: () => {},
    });

    expect(screen.getByLabelText('Available models').textContent).toMatch(
      /^gpt-5\.6-terragpt-5\.4$/,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'gpt-5.6-terra' }));
    expect(onmodelselect).toHaveBeenCalledWith('gpt-5.6-terra');
    expect(onscrollbottom).toHaveBeenCalledOnce();
  });

  it('keeps reasoning choices visible after command completion adds a space', () => {
    render(Composer, {
      status: 'Ready.',
      message: '/reasoning ',
      activeTurnId: null,
      starting: false,
      onchange: () => {},
      onsend: () => {},
      oninterrupt: () => {},
    });

    expect(screen.getByLabelText('Reasoning efforts').textContent).toBe('lowmediumhigh');
  });
});
