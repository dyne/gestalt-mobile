/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

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
  const onselectopen = vi.fn();
  const onskillprofilechange = vi.fn();
  const onmanageprofiles = vi.fn();
  const result = render(SessionsView, {
    sessions: [],
    recentSessions: [],
    selectedSessionId: null,
    workspaceTree: [root],
    workspaceId: root.id,
    expandedIds: new Set([root.id, intermediate.id]),
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    skillProfiles: [{ version: 1, name: 'focused', path: '/profiles/focused.yml', skills: [] }],
    selectedSkillProfile: '',
    skillProfileError: '',
    startingSession: false,
    onworkspacechange,
    onexpandedchange,
    onsandboxchange: vi.fn(),
    onapprovalpolicychange: vi.fn(),
    onskillprofilechange,
    onmanageprofiles,
    onopen: vi.fn(),
    onselectopen,
    onclose: vi.fn(),
    onopenrecent: vi.fn(),
    onforget: vi.fn(),
    oncopyresume: vi.fn(),
    onstart,
    ...overrides,
  });
  return { ...result, onworkspacechange, onexpandedchange, onskillprofilechange, onmanageprofiles, onselectopen, onstart };
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

    await fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
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
      (screen.getByRole('button', { name: 'Create session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    unmount();

    renderView({ startingSession: true });
    expect((screen.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('selects a named profile only for new sessions and opens its manager', async () => {
    const { onskillprofilechange, onmanageprofiles } = renderView();
    const select = screen.getByLabelText('Skills profile');
    expect((select as HTMLSelectElement).value).toBe('');
    expect((select as HTMLSelectElement).options[0]?.text).toBe('Default');
    expect((screen.getByLabelText('Sandbox') as HTMLSelectElement).value).toBe('workspace-write');
    expect(screen.queryByText('The selected skill set is fixed after this session is created.')).toBeNull();
    await fireEvent.change(select, { target: { value: 'focused' } });
    expect(onskillprofilechange).toHaveBeenCalledWith('focused');
    await fireEvent.click(screen.getByRole('button', { name: 'Manage skill profiles' }));
    expect(onmanageprofiles).toHaveBeenCalledOnce();
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows a badge only for managed sessions with a named profile snapshot', () => {
    renderView({
      sessions: [
        { id: 'named', state: 'ready', workspacePath: '/named', effectiveSkillSelection: { selectedProfileName: 'focused', skills: [] } },
        { id: 'saved-named', state: 'released', workspacePath: '/saved-named', effectiveSkillSelection: { selectedProfileName: 'team', skills: [] } },
        { id: 'default', state: 'released', workspacePath: '/default', effectiveSkillSelection: { skills: [] } },
      ],
    });
    expect(screen.getByText('Skills profile: focused')).toBeTruthy();
    expect(screen.getByText('Skills profile: team')).toBeTruthy();
    expect(screen.queryByText('Skills profile: default')).toBeNull();
  });

  it('selects another open session and marks only the Chat session as current', async () => {
    const { onselectopen } = renderView({
      selectedSessionId: 'open-a',
      sessions: [
        { id: 'open-a', state: 'ready', workspacePath: '/a' },
        { id: 'open-b', state: 'turnActive', workspacePath: '/b' },
      ],
    });
    expect(screen.getByRole('button', { name: /\/a/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /\/b/ }).getAttribute('aria-current')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /\/b/ }));
    expect(onselectopen).toHaveBeenCalledWith('open-b');
  });
});
