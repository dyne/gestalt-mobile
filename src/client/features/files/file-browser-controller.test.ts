/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { FileBrowserController, type DirectoryReader } from './file-browser-controller.js';

describe('FileBrowserController', () => {
  it('loads a directory once, appends unique pages, and preserves selected state', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        directory: '',
        entries: [{ name: 'a', path: 'a', kind: 'file' }],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        directory: '',
        entries: [
          { name: 'a', path: 'a', kind: 'file' },
          { name: 'b', path: 'b', kind: 'file' },
        ],
      });
    const controller = new FileBrowserController('root', read, vi.fn());
    await controller.load();
    await controller.load('', true);
    controller.select('b');
    expect(controller.state('').entries.map((entry) => entry.path)).toEqual(['a', 'b']);
    expect(controller.selectedPath).toBe('b');
  });

  it('ignores aborted stale child responses after collapse', async () => {
    let complete: ((value: { directory: string; entries: [] }) => void) | undefined;
    const read: DirectoryReader = vi.fn((_id, input) =>
      input?.directory === 'folder'
        ? new Promise<{ directory: string; entries: [] }>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve({
            directory: '',
            entries: [{ name: 'folder', path: 'folder', kind: 'directory' as const }],
          }),
    );
    const controller = new FileBrowserController('root', read, vi.fn());
    await controller.load();
    const loading = controller.expand('folder');
    controller.collapse('folder');
    complete?.({ directory: 'folder', entries: [] });
    await loading;
    expect(controller.expanded.has('folder')).toBe(false);
    expect(controller.state('folder').entries).toEqual([]);
  });

  it('invalidates only the refreshed branch and aborts every request on close', async () => {
    const signals: AbortSignal[] = [];
    const read: DirectoryReader = vi.fn((_id, _input, signal) => {
      signals.push(signal!);
      return new Promise<never>(() => {});
    });
    const controller = new FileBrowserController('root', read, vi.fn());
    void controller.load();
    controller.close();
    expect(signals[0]?.aborted).toBe(true);
  });
});
