/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import SessionsView from './SessionsView.svelte';

afterEach(cleanup);

const repository: WorkspaceOption = {
  id: 'opaque:group/repository%leaf',
  name: 'repository',
  relativePath: 'group/repository',
  isGitRepository: true,
  children: [],
};
const intermediate: WorkspaceOption = {
  id: 'opaque:group',
  name: 'group',
  relativePath: 'group',
  isGitRepository: false,
  children: [repository],
};
const root: WorkspaceOption = {
  id: 'opaque:root',
  name: 'workspace',
  relativePath: '.',
  isGitRepository: false,
  children: [intermediate],
};

function renderView(overrides: Record<string, unknown> = {}) {
  const onworkspacechange = vi.fn();
  const onexpandedchange = vi.fn();
  const onstart = vi.fn();
  const result = render(SessionsView, {
    sessions: [],
    recentSessions: [],
    workspaceTree: [root],
    workspaceId: root.id,
    expandedIds: new Set([root.id, intermediate.id]),
    sandbox: '',
    approvalPolicy: 'on-request',
    startingSession: false,
    onworkspacechange,
    onexpandedchange,
    onsandboxchange: vi.fn(),
    onapprovalpolicychange: vi.fn(),
    onopen: vi.fn(),
    onclose: vi.fn(),
    onopenrecent: vi.fn(),
    onforget: vi.fn(),
    oncopyresume: vi.fn(),
    onstart,
    ...overrides,
  });
  return { ...result, onworkspacechange, onexpandedchange, onstart };
}

describe('SessionsView session base tree', () => {
  it('replaces the workspace select and emits exact IDs for every node depth', async () => {
    const { onworkspacechange, onstart } = renderView();

    expect(screen.queryByLabelText('Workspace')).toBeNull();
    expect(screen.getByRole('tree', { name: 'Session base' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: /^workspace/ }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await fireEvent.click(screen.getByRole('treeitem', { name: /^group/ }));
    await fireEvent.click(screen.getByRole('treeitem', { name: /^repository/ }));
    expect(onworkspacechange).toHaveBeenNthCalledWith(1, intermediate.id);
    expect(onworkspacechange).toHaveBeenNthCalledWith(2, repository.id);

    await fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onstart).toHaveBeenCalledOnce();
  });

  it('keeps folding controlled separately from the selected highlight', async () => {
    const { onexpandedchange, onworkspacechange } = renderView({
      workspaceId: repository.id,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse group' }));
    expect(onexpandedchange).toHaveBeenCalledWith(new Set([root.id]));
    expect(onworkspacechange).not.toHaveBeenCalled();
  });

  it('disables starting only while starting or without a valid selected node', () => {
    const { unmount } = renderView({ workspaceId: 'missing' });
    expect(
      (screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    unmount();

    renderView({ startingSession: true });
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
