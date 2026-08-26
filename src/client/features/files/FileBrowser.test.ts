/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
  transfers: {
    copyEntry?: ReturnType<typeof vi.fn>;
    moveEntry?: ReturnType<typeof vi.fn>;
    deleteEntry?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onclose = vi.fn();
  const onerror = vi.fn();
  const onsuccess = vi.fn();
  const copyEntry = transfers.copyEntry ?? vi.fn(async () => ({ path: '', kind: 'file' }));
  const moveEntry = transfers.moveEntry ?? vi.fn(async () => ({ path: '', kind: 'file' }));
  const deleteEntry = transfers.deleteEntry ?? vi.fn(async () => ({ path: '', kind: 'file' }));
  const reader: DirectoryReader = (workspaceId, input, signal) =>
    listDirectory(workspaceId, input, signal);
  render(FileBrowser, {
    root,
    listDirectory: reader,
    copyEntry: copyEntry as (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) => Promise<{ path: string; kind: string }>,
    moveEntry: moveEntry as (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) => Promise<{ path: string; kind: string }>,
    deleteEntry: deleteEntry as (
      workspaceId: string,
      path: string,
      key: string,
    ) => Promise<{ path: string; kind: string }>,
    onclose,
    onerror,
    onsuccess,
  });
  return { listDirectory, copyEntry, moveEntry, deleteEntry, onclose, onerror, onsuccess };
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

  it('copies through an explicit destination picker and selects the server-returned name', async () => {
    const listDirectory = vi.fn().mockResolvedValue({
      directory: '',
      entries: [
        { name: 'report.txt', path: 'report.txt', kind: 'file' as const },
        { name: 'archive', path: 'archive', kind: 'directory' as const },
      ],
    });
    const copyEntry = vi
      .fn()
      .mockResolvedValue({ path: 'archive/report (copy).txt', kind: 'file' });
    const { onsuccess } = renderBrowser(listDirectory, { copyEntry });
    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    await screen.findByText('report.txt');
    await fireEvent.click(screen.getByRole('treeitem', { name: /report.txt/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await fireEvent.click(screen.getByRole('treeitem', { name: /archive/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm copy' }));
    await waitFor(() => expect(copyEntry).toHaveBeenCalledOnce());
    expect(copyEntry.mock.calls[0]?.[1]).toEqual({
      source: 'report.txt',
      destinationDirectory: 'archive',
      conflict: 'reject',
    });
    expect(onsuccess).toHaveBeenCalledWith('Copied archive/report (copy).txt.');
  });

  it('focuses the conflict panel and offers only eligible conflict choices', async () => {
    const listDirectory = vi.fn().mockResolvedValue({
      directory: '',
      entries: [{ name: 'report.txt', path: 'report.txt', kind: 'file' as const }],
    });
    const copyEntry = vi.fn().mockRejectedValue({ status: 409, replaceAllowed: false });
    renderBrowser(listDirectory, { copyEntry });
    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    await screen.findByText('report.txt');
    await fireEvent.click(screen.getByRole('treeitem', { name: /report.txt/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Use root folder' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm copy' }));
    const panel = await screen.findByLabelText('File conflict');
    expect(document.activeElement).toBe(panel);
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep both' })).toBeTruthy();
  });

  it('requires a separate, initially-cancel-focused confirmation before deleting', async () => {
    const listDirectory = vi.fn().mockResolvedValue({
      directory: '',
      entries: [{ name: 'folder', path: 'folder', kind: 'directory' as const }],
    });
    const deleteEntry = vi.fn().mockResolvedValue({ path: 'folder', kind: 'directory' });
    renderBrowser(listDirectory, { deleteEntry });
    await screen.findByText('folder');
    await fireEvent.click(screen.getByRole('treeitem', { name: /folder/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(
      within(screen.getByLabelText('Delete confirmation')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(deleteEntry).toHaveBeenCalledOnce());
    expect(deleteEntry.mock.calls[0]?.slice(0, 2)).toEqual(['opaque-root', 'folder']);
  });
});
