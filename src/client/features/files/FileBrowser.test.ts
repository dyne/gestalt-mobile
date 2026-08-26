/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileBrowser from './FileBrowser.svelte';

const root = {
  id: 'opaque-root',
  name: 'root',
  relativePath: 'projects/demo',
  isGitRepository: true,
  children: [],
};

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

type DirectoryReader = (
  workspaceId: string,
  input?: { directory?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
) => Promise<{ directory: string; entries: readonly never[] }>;

function renderBrowser(
  listDirectory: DirectoryReader = vi.fn(async () => ({ directory: '', entries: [] })),
) {
  const onclose = vi.fn();
  const onerror = vi.fn();
  render(FileBrowser, { root, listDirectory, onclose, onerror });
  return { listDirectory, onclose, onerror };
}

describe('FileBrowser modal lifecycle', () => {
  it('opens a named native dialog rooted at the captured workspace and reports empty content', async () => {
    const { listDirectory } = renderBrowser();
    const dialog = await screen.findByRole('dialog', { name: 'Files in ~/projects/demo' });
    expect(dialog.hasAttribute('open')).toBe(true);
    await screen.findByText('This folder is empty.');
    expect(listDirectory).toHaveBeenCalledWith(
      'opaque-root',
      { directory: '' },
      expect.any(AbortSignal),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Files in ~/projects/demo' }),
    );
  });

  it('shows retryable error state and closes from Close or Escape', async () => {
    const failure = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ directory: '', entries: [] });
    const { onclose, onerror } = renderBrowser(failure);
    await screen.findByText('Files could not be read. Try again.');
    expect(onerror).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry loading files' }));
    await screen.findByText('This folder is empty.');
    await fireEvent.click(screen.getByRole('button', { name: 'Close file browser' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight read when closed and handles Escape', async () => {
    let signal: AbortSignal | undefined;
    const listDirectory: DirectoryReader = vi.fn((_id, _input, inputSignal) => {
      signal = inputSignal;
      return new Promise<{ directory: string; entries: readonly never[] }>(() => {});
    });
    const { onclose } = renderBrowser(listDirectory);
    await waitFor(() => expect(signal).toBeDefined());
    const dialog = screen.getByRole('dialog');
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(signal?.aborted).toBe(true);
    expect(onclose).toHaveBeenCalledOnce();
  });
});
