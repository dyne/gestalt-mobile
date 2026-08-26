/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FileTree from './FileTree.svelte';
import { FileBrowserController } from './file-browser-controller.js';

describe('FileTree', () => {
  it('exposes accessible tree navigation and leaves symlinks inert', async () => {
    const read = vi.fn(async (_id: string, input?: { directory?: string }) => ({
      directory: input?.directory ?? '',
      entries:
        input?.directory === 'folder'
          ? [{ name: 'child', path: 'folder/child', kind: 'file' as const }]
          : [
              { name: 'folder', path: 'folder', kind: 'directory' as const },
              { name: 'link', path: 'link', kind: 'symlink' as const },
            ],
    }));
    let revision = 0;
    const controller = new FileBrowserController('root', read, () => {
      revision += 1;
    });
    await controller.load();
    const view = render(FileTree, { controller, revision });
    const tree = screen.getByRole('tree', { name: 'Files' });
    const [folder, link] = screen.getAllByRole('treeitem');
    expect(tree).toBeTruthy();
    expect(folder?.getAttribute('aria-expanded')).toBe('false');
    expect(link?.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.keyDown(folder!, { key: 'ArrowRight' });
    expect(read).toHaveBeenCalledWith('root', { directory: 'folder' }, expect.any(AbortSignal));
    await controller.expand('folder');
    await view.rerender({ controller, revision: ++revision });
    const group = screen.getByRole('group', { name: 'Contents of folder' });
    expect(folder?.contains(group)).toBe(true);
    expect(within(group).getByRole('treeitem', { name: 'child' }).getAttribute('aria-level')).toBe(
      '2',
    );
    await fireEvent.keyDown(link!, { key: 'Enter' });
    expect(controller.selectedPath).not.toBe('link');
    expect(link?.tagName).toBe('DIV');
    expect(link?.getAttribute('aria-describedby')).toBe('link-unsupported');
  });
});
