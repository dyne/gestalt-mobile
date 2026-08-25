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

  it('explains detached reading and keeps a retry action accessible while acquisition fails', async () => {
    const retry = vi.fn();
    render(Composer, {
      status: 'Starting Codex turn…',
      message: 'retry this',
      activeTurnId: null,
      starting: true,
      detached: true,
      retryMessage: 'This thread is active in another Codex client. Release it there, then retry.',
      retryable: true,
      onchange: () => {},
      onsend: () => {},
      onretry: retry,
      oninterrupt: () => {},
    });

    expect(
      screen.getByText('You can read this conversation. Sending will connect to Codex.'),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('active in another Codex client');
    expect((screen.getByRole('button', { name: 'Retry send' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(retry).not.toHaveBeenCalled();
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
    expect(onchange).toHaveBeenLastCalledWith('/');
    expect(onsend).not.toHaveBeenCalled();

    await fireEvent.keyDown(prompt, { key: 'Tab' });
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

    await fireEvent.keyDown(prompt, { key: 'Tab' });
    expect(onscrollbottom).toHaveBeenCalledTimes(1);
  });

  it('sends with Ctrl+Enter or the side button and leaves plain Enter available for editing', async () => {
    const onsend = vi.fn();
    render(Composer, {
      status: 'Ready.',
      message: 'first line',
      activeTurnId: null,
      starting: false,
      onchange: () => {},
      onsend,
      oninterrupt: () => {},
    });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    await fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(onsend).not.toHaveBeenCalled();
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    expect(onsend).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    expect(onsend).toHaveBeenCalledTimes(2);
  });

  it('does not send Ctrl+Enter while unavailable or composing text', async () => {
    const onsend = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Ready.',
      message: 'first line',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend,
      oninterrupt: () => {},
    });
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });

    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    expect(onsend).not.toHaveBeenCalled();
    rerender({
      status: 'Ready.',
      message: 'first line',
      activeTurnId: null,
      starting: false,
      onchange: () => {},
      onsend,
      oninterrupt: () => {},
    });
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onsend).not.toHaveBeenCalled();
  });

  it('uses the side control to interrupt an active turn when the prompt is empty', async () => {
    const oninterrupt = vi.fn();
    render(Composer, {
      status: 'Codex is working…',
      message: '',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend: () => {},
      oninterrupt,
    });

    expect(screen.queryByRole('button', { name: 'Send prompt' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(oninterrupt).toHaveBeenCalledOnce();
  });

  it('reveals queue and interrupt-send choices from the active prompt control', async () => {
    const onqueue = vi.fn();
    const oninterruptsend = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Codex is working…',
      message: 'focus on tests',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend: () => {},
      onqueue,
      oninterruptsend,
      oninterrupt: () => {},
    });

    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose prompt action' }));
    await fireEvent.click(screen.getByText('Queue message'));
    expect(onqueue).toHaveBeenCalledOnce();
    rerender({
      status: 'Codex is working…',
      message: 'start over',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend: () => {},
      onqueue,
      oninterruptsend,
      oninterrupt: () => {},
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Choose prompt action' }));
    await fireEvent.click(screen.getByText('Interrupt and send'));
    expect(oninterruptsend).toHaveBeenCalledOnce();
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
