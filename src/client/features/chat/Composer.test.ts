/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';
import { tick } from 'svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Composer', () => {
  it('uploads dropped files without changing the draft and blocks sending until settled', async () => {
    const done = Promise.withResolvers<void>();
    const onuploadfiles = vi.fn(() => done.promise);
    const onchange = vi.fn();
    const onsend = vi.fn();
    render(Composer, {
      status: 'Ready.',
      message: 'draft',
      activeTurnId: null,
      starting: false,
      onchange,
      onsend,
      oninterrupt: vi.fn(),
      onuploadfiles,
    });
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    const file = new File(['contents'], 'note.txt');
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    await fireEvent.dragEnter(prompt, { dataTransfer });
    expect(screen.getByText(/Drop files to upload to workspace root/)).toBeTruthy();
    await fireEvent.dragOver(prompt, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    await fireEvent.drop(prompt, { dataTransfer });
    expect(onuploadfiles).toHaveBeenCalledWith([file]);
    expect(onchange).not.toHaveBeenCalled();
    expect(screen.getByText('Uploading files to workspace root…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    await fireEvent.drop(prompt, { dataTransfer });
    expect(onsend).not.toHaveBeenCalled();
    expect(onuploadfiles).toHaveBeenCalledOnce();
    done.resolve();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByText(/Upload or drop files · 100 MiB per file/)).toBeTruthy();
  });

  it('opens the file picker for an empty prompt, accepts multiple files and allows picking them again', async () => {
    const onuploadfiles = vi.fn(async () => {});
    const onsend = vi.fn();
    const props = {
      status: 'Ready.',
      message: '  ',
      activeTurnId: null,
      starting: false,
      onchange: vi.fn(),
      onsend,
      oninterrupt: vi.fn(),
      onuploadfiles,
    };
    const { rerender } = render(Composer, props);
    const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    expect(input.multiple).toBe(true);
    expect(screen.queryByRole('button', { name: 'Send prompt' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(click).toHaveBeenCalledOnce();
    await fireEvent.change(input, { target: { files: [] } });
    expect(onuploadfiles).not.toHaveBeenCalled();
    const files = [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')];
    await fireEvent.change(input, { target: { files } });
    expect(onuploadfiles).toHaveBeenCalledWith(files);
    expect(input.value).toBe('');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Upload files' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await fireEvent.change(input, { target: { files } });
    expect(onuploadfiles).toHaveBeenCalledTimes(2);
    expect(onsend).not.toHaveBeenCalled();
    await rerender({ ...props, message: 'Send this' });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull();
  });

  it.each(['', 'draft'])(
    'offers file picking alongside active-turn actions with prompt %j',
    async (message) => {
      const onuploadfiles = vi.fn(async () => {});
      render(Composer, {
        status: 'Working',
        message,
        activeTurnId: 'turn-1',
        starting: false,
        onchange: vi.fn(),
        onsend: vi.fn(),
        oninterrupt: vi.fn(),
        onuploadfiles,
      });
      const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement;
      const click = vi.spyOn(input, 'click').mockImplementation(() => {});
      const trigger = screen.getByRole('button', { name: 'Choose prompt action' });
      await fireEvent.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.queryByRole('button', { name: /^Interrupt$/ }) !== null).toBe(!message);
      expect(screen.queryByRole('button', { name: 'Queue message' }) !== null).toBe(
        Boolean(message),
      );
      expect(screen.queryByRole('button', { name: 'Interrupt and send' }) !== null).toBe(
        Boolean(message),
      );
      await fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
      expect(click).toHaveBeenCalledOnce();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      const file = new File(['contents'], 'note.txt');
      await fireEvent.change(input, { target: { files: [file] } });
      expect(onuploadfiles).toHaveBeenCalledWith([file]);
    },
  );

  it('leaves text drops available for editing and clears highlighting on drag leave', async () => {
    const onuploadfiles = vi.fn();
    render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange: vi.fn(),
      onsend: vi.fn(),
      oninterrupt: vi.fn(),
      onuploadfiles,
    });
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    expect(
      await fireEvent.drop(prompt, { dataTransfer: { types: ['text/plain'], files: [] } }),
    ).toBe(true);
    expect(onuploadfiles).not.toHaveBeenCalled();
    const dataTransfer = { types: ['Files'], files: [] };
    await fireEvent.dragEnter(prompt, { dataTransfer });
    await fireEvent.dragLeave(prompt, { dataTransfer });
    expect(screen.queryByText(/Drop files to upload to workspace root/)).toBeNull();
    await fireEvent.drop(prompt, { dataTransfer });
    expect(onuploadfiles).not.toHaveBeenCalled();
  });

  it('updates Ready elapsed time locally every 30 seconds and stops on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const readySince = Date.now();
    const props = {
      status: 'Ready.',
      readySince,
      message: '',
      activeTurnId: null,
      starting: false,
      onchange: vi.fn(),
      onsend: vi.fn(),
      oninterrupt: vi.fn(),
    };
    const view = render(Composer, props);
    expect(screen.getByRole('status').textContent).toContain('Ready since less than a minute ago');
    await vi.advanceTimersByTimeAsync(60_000);
    await tick();
    expect(screen.getByRole('status', { name: 'Ready since 1 minute ago' })).toBeTruthy();
    await view.rerender({ ...props, message: 'draft' });
    await vi.advanceTimersByTimeAsync(60_000);
    await tick();
    expect(screen.getByRole('status').textContent).toContain('Ready since 2 minutes ago');
    await view.rerender({ ...props, status: 'Codex is working…', readySince: null });
    expect(screen.getByRole('status').textContent).toBe('Codex is working…');
    await view.rerender({ ...props, readySince: Date.now() });
    expect(screen.getByRole('status').textContent).toContain('Ready since less than a minute ago');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [60, '1 hour'],
    [61, '1 hour 1 minute'],
    [122, '2 hours 2 minutes'],
    [1_440, '1 day'],
    [2_883, '2 days 3 minutes'],
  ])('formats %i elapsed minutes as %s', (minutes, label) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    render(Composer, {
      status: 'Ready.',
      readySince: Date.now() - minutes * 60_000,
      message: '',
      activeTurnId: null,
      starting: false,
      onchange: vi.fn(),
      onsend: vi.fn(),
      oninterrupt: vi.fn(),
    });
    expect(screen.getByRole('status', { name: `Ready since ${label} ago` })).toBeTruthy();
  });

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

  it('does not request revealing the prompt while typing but does after accepting a completion', async () => {
    const onchange = vi.fn();
    const onrevealprompt = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange,
      onrevealprompt,
      onsend: () => {},
      oninterrupt: () => {},
    });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    await fireEvent.input(prompt, { target: { value: '/' } });
    expect(onrevealprompt).not.toHaveBeenCalled();
    rerender({
      status: 'Ready.',
      message: '/',
      activeTurnId: null,
      starting: false,
      onchange,
      onrevealprompt,
      onsend: () => {},
      oninterrupt: () => {},
    });

    await fireEvent.keyDown(prompt, { key: 'Tab' });
    expect(onrevealprompt).toHaveBeenCalledTimes(1);
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

  it('queues Ctrl+Enter during an active turn and ignores it while unavailable or composing', async () => {
    const onsend = vi.fn();
    const onqueue = vi.fn();
    const { rerender } = render(Composer, {
      status: 'Ready.',
      message: 'first line',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend,
      onqueue,
      oninterrupt: () => {},
    });
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });

    await fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(onqueue).not.toHaveBeenCalled();
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    expect(onqueue).toHaveBeenCalledOnce();
    expect(onsend).not.toHaveBeenCalled();
    rerender({
      status: 'Ready.',
      message: 'first line',
      activeTurnId: 'turn-1',
      starting: true,
      onchange: () => {},
      onsend,
      onqueue,
      oninterrupt: () => {},
    });
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    expect(onqueue).toHaveBeenCalledOnce();
    rerender({
      status: 'Ready.',
      message: 'first line',
      activeTurnId: 'turn-1',
      starting: false,
      onchange: () => {},
      onsend,
      onqueue,
      oninterrupt: () => {},
    });
    await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onqueue).toHaveBeenCalledOnce();
    expect(onsend).not.toHaveBeenCalled();
  });

  it('offers interrupt in the action menu when an active turn has an empty prompt', async () => {
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
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose prompt action' }));
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
    const onrevealprompt = vi.fn();
    render(Composer, {
      status: 'Ready.',
      message: '/model ',
      activeTurnId: null,
      starting: false,
      models: ['gpt-5.4', 'gpt-5.6-terra'],
      onchange: () => {},
      onmodelselect,
      onrevealprompt,
      onsend: () => {},
      oninterrupt: () => {},
    });

    expect(screen.getByLabelText('Available models').textContent).toMatch(
      /^gpt-5\.6-terragpt-5\.4$/,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'gpt-5.6-terra' }));
    expect(onmodelselect).toHaveBeenCalledWith('gpt-5.6-terra');
    expect(onrevealprompt).toHaveBeenCalledOnce();
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
