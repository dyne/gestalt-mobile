/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitView from './GitView.svelte';
import type { RelayGitSummary } from '../sessions/relay-client.js';
const repository = {
  id: 'repo',
  name: 'Repository',
  relativePath: 'repo',
  isGitRepository: true,
  children: [],
};
const folder = { ...repository, id: 'folder', name: 'Folder', isGitRepository: false };
const summary: RelayGitSummary = {
  available: true,
  branch: 'topic',
  branches: ['topic'],
  upstream: null,
  originUrl: 'git@example.test:project.git',
  ahead: 0,
  behind: 0,
  dirty: { staged: 0, unstaged: 0, untracked: 0 },
  commits: [],
  fetchedAt: null,
};
function props(selectedWorkspace = repository, current: RelayGitSummary | null = summary) {
  return {
    workspaceTree: [folder, repository],
    selectedWorkspace,
    expandedIds: new Set<string>(),
    summary: current,
    refreshing: false,
    checkingOut: false,
    cloning: false,
    error: null,
    cloneStatus: null,
    confirmingPush: false,
    onpull: vi.fn(),
    oncheckout: vi.fn(),
    onopenpushconfirmation: vi.fn(),
    onpush: vi.fn(),
    oncancelpush: vi.fn(),
    onselect: vi.fn(),
    onexpandedchange: vi.fn(),
    onbrowsefiles: vi.fn(),
    onclone: vi.fn(),
  };
}
afterEach(cleanup);
describe('Git view actions', () => {
  it('shows origin, disables Clone, and enables first push for repositories', () => {
    render(GitView, props());
    expect((screen.getByLabelText('Git address') as HTMLInputElement).value).toBe(
      summary.originUrl,
    );
    expect((screen.getByLabelText('Git address') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Destination')).toBeNull();
  });
  it('allows cloning only after selecting a folder and providing an address', async () => {
    const p = props(folder, null);
    render(GitView, p);
    const clone = screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Git address'), {
      target: { value: 'https://example.test/repo.git' },
    });
    expect(clone.disabled).toBe(false);
    await fireEvent.submit(clone.closest('form')!);
    expect(p.onclone).toHaveBeenCalledWith('https://example.test/repo.git');
  });
  it('updates origin when selecting another repository without overwriting the clone draft', async () => {
    const p = props(folder, null);
    const view = render(GitView, p);
    await fireEvent.input(screen.getByLabelText('Git address'), {
      target: { value: 'https://example.test/draft.git' },
    });
    await view.rerender(props(repository));
    expect((screen.getByLabelText('Git address') as HTMLInputElement).value).toBe(
      summary.originUrl,
    );
    await view.rerender(
      props(repository, { ...summary, originUrl: 'https://example.test/other.git' }),
    );
    expect((screen.getByLabelText('Git address') as HTMLInputElement).value).toBe(
      'https://example.test/other.git',
    );
    await view.rerender(props(folder, null));
    expect((screen.getByLabelText('Git address') as HTMLInputElement).value).toBe(
      'https://example.test/draft.git',
    );
  });
  it('explains unavailable push and keeps push confirmation busy during publication', async () => {
    const view = render(GitView, props(repository, { ...summary, originUrl: null }));
    expect(screen.getByText('No origin remote is configured.')).toBeTruthy();
    await view.rerender({ ...props(), confirmingPush: true, pushing: true });
    expect(screen.getByText('Publish topic to origin and set its upstream?')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pushing…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
