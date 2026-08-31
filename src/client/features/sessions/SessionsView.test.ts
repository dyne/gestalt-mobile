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
    openingSessionId: null,
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
  return {
    ...result,
    onworkspacechange,
    onexpandedchange,
    onskillprofilechange,
    onmanageprofiles,
    onselectopen,
    onstart,
  };
}

describe('SessionsView session base tree', () => {
  it('orders open-session actions in a vertical rail and keeps status controls accessible', () => {
    const activity = {
      sessionId: 'live',
      confidence: 'fresh' as const,
      aggregateSubagents: 'working' as const,
      root: {
        state: 'working' as const,
        observedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
      subagents: [],
    };
    const { container } = renderView({
      sessions: [
        {
          id: 'live',
          state: 'ready',
          workspacePath: '/work',
          resumeCommand: 'codex resume live',
        },
      ],
      activitySnapshots: new Map([['live', activity]]),
    });
    expect(screen.getByText('Agents (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Autopilot: Unavailable' })).toBeTruthy();
    const actions = Array.from(container.querySelector('.open-session .session-actions')!.children);
    const control = (index: number, selector: string) =>
      actions[index]?.matches(selector) ? actions[index] : actions[index]?.querySelector(selector);
    expect(control(0, 'button')?.textContent?.trim()).toBe('Open');
    expect(control(1, 'button')?.textContent?.trim()).toBe('Copy');
    expect(control(2, 'button')?.getAttribute('aria-label')).toBe('Autopilot: Unavailable');
    expect(control(3, 'summary')?.textContent?.trim()).toBe('Agents (1)');
    expect(control(4, 'button')?.textContent?.trim()).toBe('Close');
  });

  it('uses accent-pressed state without a visible on/off glyph for session Autopilot', () => {
    renderView({
      sessions: [{ id: 'live', state: 'ready', workspacePath: '/work' }],
      autopilotSnapshots: new Map([
        [
          'live',
          {
            state: 'monitoring',
            enabled: true,
            retry: { position: 0, limit: 0 },
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      ]),
    });

    const autopilot = screen.getByRole('button', { name: 'Autopilot: Monitoring' });
    expect(autopilot.textContent?.trim()).toBe('Autopilot');
    expect(autopilot.getAttribute('aria-pressed')).toBe('true');
    expect(autopilot.classList.contains('accentPressed')).toBe(true);
  });
  it('makes a disconnected session activity projection explicit in local Autopilot liveness', () => {
    renderView({
      sessions: [{ id: 'live', state: 'ready', workspacePath: '/work' }],
      autopilotSnapshots: new Map([
        [
          'live',
          {
            state: 'monitoring',
            enabled: true,
            retry: { position: 0, limit: 3 },
            updatedAt: '2026-08-31T12:00:00.000Z',
          },
        ],
      ]),
      activitySnapshots: new Map([
        [
          'live',
          {
            sessionId: 'live',
            confidence: 'stale',
            aggregateSubagents: 'idle',
            root: {
              state: 'disconnected',
              observedAt: '2026-08-31T12:00:00.000Z',
              lastActivityAt: '2026-08-31T12:00:00.000Z',
            },
            subagents: [],
          },
        ],
      ]),
    });
    const liveness = screen.getByRole('status', { name: 'Monitoring disconnected' });
    expect(liveness.getAttribute('data-state')).toBe('disconnected');
    expect(liveness.classList.contains('active')).toBe(false);
  });
  it('uses clear approval labels while emitting the Codex policy value', async () => {
    const onapprovalpolicychange = vi.fn();
    renderView({ onapprovalpolicychange });

    const policy = screen.getByLabelText('Approval policy') as HTMLSelectElement;
    expect(policy.textContent).toContain('Ask on all commands');
    expect(policy.textContent).toContain('Ask out of workspace');
    expect(policy.textContent).toContain('Approve everything');
    expect(screen.getByText(/does not expand the sandbox's technical permissions/i)).toBeTruthy();
    await fireEvent.change(policy, { target: { value: 'never' } });
    expect(onapprovalpolicychange).toHaveBeenCalledWith('never');
  });

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

  it('disables only the Open button whose session is recovering', () => {
    renderView({
      sessions: [
        { id: 'opening', state: 'released', workspacePath: '/workspace' },
        { id: 'other', state: 'stopped', workspacePath: '/other' },
      ],
      openingSessionId: 'opening',
    });
    expect((screen.getByRole('button', { name: 'Opening…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('selects a named profile only for new sessions and opens its manager', async () => {
    const { onskillprofilechange, onmanageprofiles } = renderView();
    const select = screen.getByLabelText('Skills profile');
    expect((select as HTMLSelectElement).value).toBe('');
    expect((select as HTMLSelectElement).options[0]?.text).toBe('Default');
    expect((screen.getByLabelText('Sandbox') as HTMLSelectElement).value).toBe('workspace-write');
    expect(
      screen.queryByText('The selected skill set is fixed after this session is created.'),
    ).toBeNull();
    await fireEvent.change(select, { target: { value: 'focused' } });
    expect(onskillprofilechange).toHaveBeenCalledWith('focused');
    await fireEvent.click(screen.getByRole('button', { name: 'Manage skill profiles' }));
    expect(onmanageprofiles).toHaveBeenCalledOnce();
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it('shows a badge only for managed sessions with a named profile snapshot', () => {
    renderView({
      sessions: [
        {
          id: 'named',
          state: 'ready',
          workspacePath: '/named',
          effectiveSkillSelection: { selectedProfileName: 'focused', skills: [] },
        },
        {
          id: 'saved-named',
          state: 'released',
          workspacePath: '/saved-named',
          effectiveSkillSelection: { selectedProfileName: 'team', skills: [] },
        },
        {
          id: 'default',
          state: 'released',
          workspacePath: '/default',
          effectiveSkillSelection: { skills: [] },
        },
      ],
    });
    expect(screen.getByText('Skills profile: focused')).toBeTruthy();
    expect(screen.getByText('Skills profile: team')).toBeTruthy();
    expect(screen.queryByText('Skills profile: default')).toBeNull();
  });

  it('shows an open session’s Org Plan identity and compact positioned progress', () => {
    renderView({
      sessions: [
        {
          id: 'planned',
          state: 'ready',
          workspacePath: '/planned',
          lastOrgPlan: { filename: 'session-summary.org', title: 'Show session context' },
          plan: {
            title: 'Show session context',
            steps: [
              {
                id: 'layout',
                title: 'Layout',
                level: 1,
                state: 'WIP',
                priority: 'A',
                description: { effort: 'Small' },
                children: [
                  {
                    id: 'layout-progress',
                    title: 'Progress',
                    level: 2,
                    state: 'DONE',
                    priority: 'A',
                    description: {},
                    children: [],
                  },
                  {
                    id: 'layout-current',
                    title: 'Current child work',
                    level: 2,
                    state: 'WIP',
                    priority: 'A',
                    description: {},
                    children: [],
                  },
                ],
              },
            ],
            totalSteps: 3,
            doneSteps: 1,
            allDone: false,
            currentStepId: 'layout-current',
          },
        },
      ],
    });
    const title = screen.getByText('Show session context');
    const filename = screen.getByText('session-summary.org');
    expect(title.classList.contains('org-plan-title')).toBe(true);
    expect(filename.classList.contains('org-plan-filename')).toBe(true);
    expect(title.parentElement).toBe(filename.parentElement);
    const progress = screen.getByRole('progressbar', {
      name: 'Plan progress for Show session context',
    });
    expect(progress.closest('.session-details')).toBeTruthy();
    expect(screen.getByLabelText('L1: Layout, WIP, effort Small')).toBeTruthy();
    expect(screen.getByLabelText('L1.2: Current child work, WIP')).toBeTruthy();
    expect(screen.getByText('Effort: Small')).toBeTruthy();
    expect(screen.queryByLabelText('L1.1: Progress, DONE')).toBeNull();
    expect(screen.queryByText('Progress')).toBeNull();
  });

  it('shows available metadata for a recent session', () => {
    renderView({
      recentSessions: [
        {
          id: 'recent',
          cwd: '/recent',
          recencyAt: 0,
          resumeCommand: 'codex resume recent',
          model: 'gpt-5.4',
          skillProfile: 'focused',
          orgPlanFilename: 'recent-context.org',
        },
      ],
    });
    expect(screen.getByText('Model: gpt-5.4')).toBeTruthy();
    expect(screen.getByText('Skills profile: focused')).toBeTruthy();
    expect(screen.getByText('Org plan: recent-context.org')).toBeTruthy();
  });

  it('selects another open session and marks only the Chat session as current', async () => {
    const { onselectopen } = renderView({
      selectedSessionId: 'open-a',
      sessions: [
        { id: 'open-a', state: 'ready', workspacePath: '/a' },
        { id: 'open-b', state: 'turnActive', workspacePath: '/b' },
      ],
    });
    const openButtons = screen.getAllByRole('button', { name: 'Open' });
    expect(openButtons[0]?.getAttribute('aria-current')).toBe('page');
    expect(openButtons[1]?.getAttribute('aria-current')).toBeNull();
    await fireEvent.click(openButtons[1]!);
    expect(onselectopen).toHaveBeenCalledWith('open-b');
  });

  it('copies resume commands from open and saved adopted sessions', async () => {
    const oncopyresume = vi.fn();
    renderView({
      oncopyresume,
      sessions: [
        {
          id: 'open',
          state: 'turnActive',
          workspacePath: '/open',
          resumeCommand: 'codex resume open',
        },
        {
          id: 'saved',
          state: 'released',
          workspacePath: '/saved',
          resumeCommand: 'codex resume saved',
        },
      ],
    });

    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    expect(copyButtons).toHaveLength(2);
    await fireEvent.click(copyButtons[0]!);
    await fireEvent.click(copyButtons[1]!);
    expect(oncopyresume).toHaveBeenNthCalledWith(1, 'codex resume open');
    expect(oncopyresume).toHaveBeenNthCalledWith(2, 'codex resume saved');
  });

  it('reuses the shared rounded control for session actions', () => {
    renderView({
      sessions: [
        {
          id: 'saved',
          state: 'released',
          workspacePath: '/saved',
          resumeCommand: 'codex resume saved',
        },
      ],
    });

    for (const name of ['Open', 'Copy', 'Forget', 'Manage skill profiles', 'Create session']) {
      expect(screen.getByRole('button', { name }).classList.contains('app-control')).toBe(true);
    }
  });
});
