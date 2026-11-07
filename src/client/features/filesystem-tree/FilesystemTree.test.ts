/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import FilesystemTree from './FilesystemTree.svelte';
import { treeNodePolicies } from './tree-state.js';

afterEach(cleanup);

const repository: WorkspaceOption = {
  id: 'group/repository',
  name: 'repository-with-a-very-long-name',
  relativePath: 'group/repository-with-a-very-long-name',
  isGitRepository: true,
  children: [],
};

const roots: WorkspaceOption[] = [
  {
    id: '.',
    name: 'workspace',
    relativePath: '.',
    isGitRepository: false,
    children: [
      {
        id: 'group',
        name: 'group',
        relativePath: 'group',
        isGitRepository: false,
        children: [repository],
      },
    ],
  },
];

function renderTree(overrides: Record<string, unknown> = {}) {
  const onexpandedchange = vi.fn();
  const onselect = vi.fn();
  const result = render(FilesystemTree, {
    roots,
    expandedIds: new Set(['.', 'group']),
    selectedId: 'group',
    label: 'Session base',
    onexpandedchange,
    onselect,
    ...overrides,
  });
  return { ...result, onexpandedchange, onselect };
}

describe('FilesystemTree semantics and pointer interaction', () => {
  it('renders controlled tree state, repository identity, and shortened paths', () => {
    renderTree();

    const tree = screen.getByRole('tree', { name: 'Session base' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items).toHaveLength(3);
    expect(items[0]?.getAttribute('aria-level')).toBe('1');
    expect(items[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');
    expect(items[1]?.getAttribute('tabindex')).toBe('0');
    expect(items.filter((item) => item.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(
      within(tree)
        .getAllByRole('button', { name: /^(Collapse|Expand) / })
        .every((disclosure) => disclosure.getAttribute('tabindex') === '-1'),
    ).toBe(true);
    expect(items[2]?.hasAttribute('aria-expanded')).toBe(false);
    expect(items[2]?.textContent).toContain('Git');
    expect(items[2]?.getAttribute('title')).toBe('~/group/repository-with-a-very-long-name');
  });

  it('keeps disclosure and selection actions separate', async () => {
    const { onexpandedchange, onselect } = renderTree();

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse group' }));
    expect(onexpandedchange).toHaveBeenCalledWith(new Set(['.']));
    expect(onselect).not.toHaveBeenCalled();

    await fireEvent.click(
      screen.getByRole('treeitem', { name: /repository-with-a-very-long-name/ }),
    );
    expect(onselect).toHaveBeenCalledWith(repository);
  });

  it('marks ineligible nodes without removing them from tree navigation', async () => {
    const { onselect } = renderTree({ isSelectable: treeNodePolicies.gitRepositoryTarget });
    const group = screen.getByRole('treeitem', { name: /^group/ });

    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect(group.getAttribute('tabindex')).toBe('0');
    await fireEvent.click(group);
    expect(onselect).not.toHaveBeenCalled();
  });
});

describe('FilesystemTree keyboard interaction', () => {
  it('focuses on opening and scrolls a changed selection into view', async () => {
    const scroll = vi.fn();
    const { rerender } = renderTree({ selectedId: '.' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /^workspace/ })),
    );
    const group = screen.getByRole('treeitem', { name: /^group/ });
    group.scrollIntoView = scroll;
    await rerender({ selectedId: 'group' });
    await waitFor(() => expect(document.activeElement).toBe(group));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('reveals a deep selected item on opening without expanding unrelated folders', async () => {
    const { onexpandedchange, rerender } = renderTree({
      selectedId: repository.id,
      expandedIds: new Set(['.']),
    });

    await waitFor(() => expect(onexpandedchange).toHaveBeenCalledWith(new Set(['.', 'group'])));
    await rerender({ expandedIds: new Set(['.', 'group']) });
    const item = screen.getByRole('treeitem', { name: /repository-with-a-very-long-name/ });
    await waitFor(() => expect(document.activeElement).toBe(item));

    onexpandedchange.mockClear();
    await rerender({ expandedIds: new Set(['.']) });
    expect(onexpandedchange).not.toHaveBeenCalled();
    expect(screen.queryByRole('treeitem', { name: /repository-with-a-very-long-name/ })).toBeNull();
  });

  it('waits for an asynchronously loaded selection and restores it on reopening', async () => {
    const { rerender, unmount } = renderTree({ roots: [], selectedId: null });
    await rerender({ roots, selectedId: repository.id });
    const selectedItem = screen.getByRole('treeitem', { name: /repository-with-a-very-long-name/ });
    await waitFor(() => expect(document.activeElement).toBe(selectedItem));
    unmount();

    renderTree({ selectedId: repository.id });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('treeitem', { name: /repository-with-a-very-long-name/ }),
      ),
    );
  });

  it('moves through visible nodes and between parent and child', async () => {
    renderTree();
    const items = screen.getAllByRole('treeitem');

    items[0]!.focus();
    await fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(items[1]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[2]);
    await fireEvent.keyDown(items[2]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(items[1]!, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    await fireEvent.keyDown(items[0]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    await fireEvent.keyDown(items[2]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('expands and collapses without changing selection', async () => {
    const { onexpandedchange, onselect } = renderTree();
    const group = screen.getByRole('treeitem', { name: /^group/ });

    await fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onexpandedchange).toHaveBeenCalledWith(new Set(['.']));
    expect(onselect).not.toHaveBeenCalled();
  });

  it('selects with Enter and Space', async () => {
    const { onselect } = renderTree();
    const item = screen.getByRole('treeitem', { name: /repository-with-a-very-long-name/ });

    await fireEvent.keyDown(item, { key: 'Enter' });
    await fireEvent.keyDown(item, { key: ' ' });
    expect(onselect).toHaveBeenNthCalledWith(1, repository);
    expect(onselect).toHaveBeenNthCalledWith(2, repository);
  });
});
