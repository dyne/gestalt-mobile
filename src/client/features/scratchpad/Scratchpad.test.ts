/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Scratchpad from './Scratchpad.svelte';
import { SCRATCHPAD_STORAGE_KEY } from './scratchpad-storage.js';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Scratchpad', () => {
  it('loads saved text, auto-saves edits, and exposes native text selection', async () => {
    localStorage.setItem(SCRATCHPAD_STORAGE_KEY, 'Remember this');
    render(Scratchpad, { onclose: vi.fn() });

    const field = (await screen.findByLabelText('Scratchpad text')) as HTMLTextAreaElement;
    expect(field.value).toBe('Remember this');
    await vi.waitFor(() => expect(document.activeElement).toBe(field));

    await fireEvent.input(field, { target: { value: 'Remember this\nand that' } });
    expect(localStorage.getItem(SCRATCHPAD_STORAGE_KEY)).toBe('Remember this\nand that');

    await fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it('pastes clipboard text at the current selection and persists it', async () => {
    const readText = vi.fn().mockResolvedValue('copied ');
    render(Scratchpad, { onclose: vi.fn(), clipboard: { readText } });
    const field = (await screen.findByLabelText('Scratchpad text')) as HTMLTextAreaElement;
    await fireEvent.input(field, { target: { value: 'keep here' } });
    field.setSelectionRange(5, 5);

    await fireEvent.click(screen.getByRole('button', { name: 'Paste' }));

    await vi.waitFor(() => expect(field.value).toBe('keep copied here'));
    expect(readText).toHaveBeenCalledOnce();
    expect(localStorage.getItem(SCRATCHPAD_STORAGE_KEY)).toBe('keep copied here');
    expect(field.selectionStart).toBe(12);
  });

  it('falls back to native paste when clipboard permission is unavailable', async () => {
    const readText = vi.fn().mockRejectedValue(new Error('denied'));
    render(Scratchpad, { onclose: vi.fn(), clipboard: { readText } });

    await fireEvent.click(await screen.findByRole('button', { name: 'Paste' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Long-press the text field and choose Paste.',
    );
  });

  it('requires confirmation before clearing all saved text', async () => {
    render(Scratchpad, { onclose: vi.fn() });
    const field = (await screen.findByLabelText('Scratchpad text')) as HTMLTextAreaElement;
    await fireEvent.input(field, { target: { value: 'Do not lose this accidentally' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Clear the entire scratchpad?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep text' }));
    expect(field.value).toBe('Do not lose this accidentally');

    await fireEvent.click(screen.getByRole('button', { name: 'Keep text' }));
    expect(screen.queryByText('Clear the entire scratchpad?')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(field.value).toBe('');
    expect(localStorage.getItem(SCRATCHPAD_STORAGE_KEY)).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('closes through the named control', async () => {
    const onclose = vi.fn();
    render(Scratchpad, { onclose });

    await fireEvent.click(await screen.findByRole('button', { name: 'Close scratchpad' }));

    expect(onclose).toHaveBeenCalledOnce();
  });
});
