/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import SessionsView from './SessionsView.svelte';

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

function expandAdvanced() {
  (document.querySelector('.advanced-settings') as HTMLDetailsElement).open = true;
}

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
    sandbox: 'workspace-git',
    approvalPolicy: 'never',
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
  it('keeps the session base above profile and model while Advanced settings starts collapsed', async () => {
    const onsavedefaults = vi.fn();
    renderView({ models: ['gpt-6.1-sol'], selectedModel: 'gpt-6.1-sol', onsavedefaults });
    expect(document.querySelectorAll('.essential-settings select')).toHaveLength(2);
    expect((document.querySelector('.advanced-settings') as HTMLDetailsElement).open).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save as defaults' }).closest('.advanced-settings'),
    ).toBeTruthy();
    expect(
      screen.getByRole('tree', { name: 'Session base' }).closest('.advanced-settings'),
    ).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Session base' })).toBeNull();
    expect(
      screen
        .getByRole('tree', { name: 'Session base' })
        .compareDocumentPosition(screen.getByLabelText('Skills profile')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByLabelText('Model thinking').closest('.advanced-settings')).toBeTruthy();
    expect(screen.getByLabelText('Executor model').closest('.advanced-settings')).toBeTruthy();
    expandAdvanced();
    expect(screen.getByRole('tree', { name: 'Session base' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Save as defaults' }));
    expect(onsavedefaults).toHaveBeenCalledOnce();
  });

  it('changes supervisor and executor thinking independently', async () => {
    const onreasoningchange = vi.fn();
    const onexecutormodelchange = vi.fn();
    const onexecutorreasoningchange = vi.fn();
    renderView({
      executorModels: ['gpt-6.1-sol'],
      onreasoningchange,
      onexecutormodelchange,
      onexecutorreasoningchange,
    });
    expandAdvanced();
    await fireEvent.change(screen.getByLabelText('Model thinking'), { target: { value: 'high' } });
    await fireEvent.change(screen.getByLabelText('Executor model'), {
      target: { value: 'gpt-6.1-sol' },
    });
    await fireEvent.change(screen.getByLabelText('Executor thinking'), {
      target: { value: 'xhigh' },
    });
    expect(onreasoningchange).toHaveBeenCalledWith('high');
    expect(onexecutormodelchange).toHaveBeenCalledWith('gpt-6.1-sol');
    expect(onexecutorreasoningchange).toHaveBeenCalledWith('xhigh');
  });

  it('requires confirmation to close and permits cancelling', async () => {
    const onclose = vi.fn();
    renderView({ sessions: [{ id: 'live', state: 'ready', workspacePath: '/work' }], onclose });
    await fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    expect(onclose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Close session?' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Close session$/ }));
    expect(onclose).toHaveBeenCalledWith('live');
  });

  it('shows supervision controls only while an Org plan is assigned', async () => {
    const session = { id: 'live', state: 'ready', workspacePath: '/work' };
    const { rerender } = renderView({ sessions: [session] });
    expect(screen.queryByRole('button', { name: /^Autopilot/ })).toBeNull();
    expect(screen.queryByText(/^Agents \(/)).toBeNull();
    await rerender({
      sessions: [
        { ...session, lastOrgPlan: { filename: 'plan.org', title: 'Plan', attached: true } },
      ],
    });
    expect(screen.getByRole('button', { name: /^Autopilot/ })).toBeTruthy();
    expect(screen.getByText(/^Agents \(/)).toBeTruthy();
    await rerender({
      sessions: [
        { ...session, lastOrgPlan: { filename: 'plan.org', title: 'Plan', attached: false } },
      ],
    });
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Autopilot/ })).toBeNull();
    expect(screen.queryByText(/^Agents \(/)).toBeNull();
  });

  it('updates the shared Agents popup when the session activity changes', async () => {
    const activity = {
      sessionId: 'live',
      confidence: 'fresh' as const,
      aggregateSubagents: 'idle' as const,
      root: {
        state: 'idle' as const,
        observedAt: '2026-10-05T00:00:00Z',
        lastActivityAt: '2026-10-05T00:00:00Z',
      },
      subagents: [],
    };
    const { rerender } = renderView({
      sessions: [
        {
          id: 'live',
          state: 'ready',
          workspacePath: '/work',
          lastOrgPlan: { filename: 'active.org', title: 'Active plan', attached: true },
        },
      ],
      activitySnapshots: new Map([['live', activity]]),
    });
    expect(screen.getByText('Agents (1)')).toBeTruthy();
    await rerender({
      activitySnapshots: new Map([
        [
          'live',
          {
            ...activity,
            aggregateSubagents: 'working',
            subagents: [
              {
                id: 'child',
                canonicalTaskName: 'worker',
                state: 'working',
                lastActivityAt: '2026-10-05T00:00:00Z',
                observedAt: '2026-10-05T00:00:00Z',
              },
            ],
          },
        ],
      ]),
    });
    expect(screen.getByText('Agents (2)')).toBeTruthy();
    (document.querySelector('.agents') as HTMLDetailsElement).open = true;
    expect(screen.getByText('worker')).toBeTruthy();
  });

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
          lastOrgPlan: { filename: 'active.org', title: 'Active plan', attached: true },
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
    expect(control(1, 'button')?.textContent?.trim()).toBe('Copy CLI');
    expect(control(2, 'button')?.getAttribute('aria-label')).toBe('Autopilot: Unavailable');
    expect(control(3, 'summary')?.textContent?.trim()).toBe('Agents (1)');
    expect(control(4, 'button')?.textContent?.trim()).toBe('Close');
  });

  it('uses accent-pressed state without a visible on/off glyph for session Autopilot', () => {
    renderView({
      sessions: [
        {
          id: 'live',
          state: 'ready',
          workspacePath: '/work',
          lastOrgPlan: { filename: 'active.org', title: 'Active plan', attached: true },
        },
      ],
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
  it('renders a stable, explainable idle verdict for an incomplete session', () => {
    renderView({
      sessions: [
        {
          id: 'stuck',
          state: 'ready',
          workspacePath: '/work',
          sessionStatus: {
            state: 'idle',
            reason: 'incompleteWithoutContinuation',
            confidence: 'fresh',
            observedAt: '2026-09-13T12:00:00.000Z',
            nextExpectedAction: 'Resume supervision.',
          },
        },
      ],
    });
    expect(
      screen.getByRole('group', { name: /idle: incompletewithoutcontinuation/i }),
    ).toBeTruthy();
    expect(screen.getByText(/Resume supervision/)).toBeTruthy();
  });
  it('keeps stale working evidence calm while fresh working evidence pulses', () => {
    const status = {
      state: 'working' as const,
      reason: 'autopilot' as const,
      observedAt: '2026-09-13T12:00:00.000Z',
      nextExpectedAction: 'Wait.',
      confidence: 'stale' as const,
    };
    const { container, unmount } = renderView({
      sessions: [{ id: 's', state: 'ready', sessionStatus: status }],
    });
    expect(container.querySelector('.verdict-dot')?.classList.contains('live')).toBe(false);
    unmount();
    renderView({
      sessions: [
        { id: 's', state: 'ready', sessionStatus: { ...status, confidence: 'fresh' as const } },
      ],
    });
    expect(document.querySelector('.verdict-dot')?.classList.contains('live')).toBe(true);
  });
  it('keeps Autopilot liveness text out of the session action rail', () => {
    renderView({
      sessions: [
        {
          id: 'live',
          state: 'ready',
          workspacePath: '/work',
          lastOrgPlan: { filename: 'active.org', title: 'Active plan', attached: true },
        },
      ],
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
    expect(screen.queryByRole('status', { name: 'Autopilot disconnected' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Autopilot: Monitoring' })).toBeTruthy();
  });
  it('uses clear approval labels while emitting the Codex policy value', async () => {
    const onapprovalpolicychange = vi.fn();
    renderView({ onapprovalpolicychange });
    expandAdvanced();

    const policy = screen.getByLabelText('Approval policy') as HTMLSelectElement;
    expect(policy.textContent).toContain('Ask on all commands');
    expect(policy.textContent).toContain('Ask out of workspace');
    expect(policy.textContent).toContain('Never ask for approval');
    expect(screen.queryByText(/does not expand the sandbox's technical permissions/i)).toBeNull();
    await fireEvent.change(policy, { target: { value: 'never' } });
    expect(onapprovalpolicychange).toHaveBeenCalledWith('never');
  });

  it('replaces the workspace select and emits exact IDs for every node depth', async () => {
    const { onworkspacechange, onstart } = renderView();
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();
    const select = screen.getByLabelText('Skills profile');
    expect((select as HTMLSelectElement).value).toBe('');
    expect((select as HTMLSelectElement).options[0]?.text).toBe('Default');
    expect((screen.getByLabelText('Sandbox') as HTMLSelectElement).value).toBe('workspace-git');
    expect((screen.getByLabelText('Approval policy') as HTMLSelectElement).value).toBe('never');
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

  it('shows recent-session metadata and copies to CLI without opening a menu', async () => {
    const oncopyresume = vi.fn();
    renderView({
      oncopyresume,
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
    expect(document.querySelector('.recent-session .session-menu')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy to CLI' }));
    expect(oncopyresume).toHaveBeenCalledWith('codex resume recent');
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

  it('shows durable plan attachments on saved sessions and keeps historical plans unmarked', () => {
    renderView({
      sessions: [
        {
          id: 'attached',
          state: 'released',
          workspacePath: '/work',
          lastOrgPlan: {
            filename: 'attached.org',
            title: 'Attached plan',
            attached: true,
            path: '/work/attached.org',
          },
        },
        {
          id: 'closed-plan',
          state: 'released',
          workspacePath: '/other',
          lastOrgPlan: { filename: 'closed.org', title: 'Closed plan', attached: false },
        },
      ],
    });
    expect(screen.getAllByText('Org plan attached')).toHaveLength(1);
    expect(screen.getByText('attached.org')).toBeTruthy();
    expect(screen.getByText('closed.org')).toBeTruthy();
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

    expect(document.querySelector('.session-menu')).toBeNull();
    const copyButtons = screen.getAllByRole('button', { name: 'Copy CLI' });
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

    expandAdvanced();
    for (const name of ['Open', 'Copy CLI', 'Forget', 'Manage skill profiles', 'Create session']) {
      expect(screen.getByRole('button', { name }).classList.contains('app-control')).toBe(true);
    }
  });
});

describe('SessionsView provider selection', () => {
  it('keeps unavailable Kimi disabled without redundant help text', () => {
    renderView();
    const picker = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(picker.value).toBe('codex');
    expect((picker.querySelector('option[value="kimi"]') as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByText(/Kimi is unavailable because its CLI was not found/i)).toBeNull();
    expect(screen.getByRole('tree', { name: 'Session base' })).toBeTruthy();
  });

  it('shows the provider picker and emits changes when kimi is available', async () => {
    const onproviderchange = vi.fn();
    renderView({ kimiAvailable: true, onproviderchange });
    const picker = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(picker.value).toBe('codex');
    await fireEvent.change(picker, { target: { value: 'kimi' } });
    expect(onproviderchange).toHaveBeenCalledWith('kimi');
  });

  it('adapts the form to kimi and hides codex-only controls', () => {
    renderView({
      provider: 'kimi',
      kimiAvailable: true,
      models: ['k2-thinking'],
      selectedModel: 'k2-thinking',
    });
    expect(screen.getByRole('tree', { name: 'Session base' })).toBeTruthy();
    expect(screen.queryByLabelText('Model thinking')).toBeNull();
    expect(screen.queryByLabelText('Executor model')).toBeNull();
    expect(screen.queryByLabelText('Sandbox')).toBeNull();
    expect(screen.queryByLabelText('Approval policy')).toBeNull();
    expect(screen.getByLabelText('Skills profile')).toBeTruthy();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('k2-thinking');
  });

  it('shows model loading state and prevents creating the session', () => {
    renderView({ kimiAvailable: true, provider: 'kimi', modelsLoading: true });
    expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('Loading models…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('disables creating a session while the model list is loaded but unset', () => {
    renderView({ models: ['k2-thinking'], selectedModel: '' });
    expect(
      (screen.getByRole('button', { name: 'Create session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('badges kimi sessions and hides their autopilot controls', () => {
    renderView({
      sessions: [
        { id: 'kimi-live', state: 'ready', workspacePath: '/kimi', provider: 'kimi' },
        {
          id: 'codex-live',
          state: 'ready',
          workspacePath: '/codex',
          lastOrgPlan: { filename: 'active.org', title: 'Active plan', attached: true },
        },
      ],
    });
    expect(screen.getByText('Kimi')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Autopilot/ })).toHaveLength(1);
  });

  it('hides stale Codex resume actions on managed Kimi sessions', () => {
    renderView({
      sessions: [
        {
          id: 'kimi-live',
          state: 'ready',
          workspacePath: '/kimi',
          provider: 'kimi',
          resumeCommand: 'codex resume kimi-thread',
        },
        {
          id: 'codex-live',
          state: 'ready',
          workspacePath: '/codex',
          resumeCommand: 'codex resume codex-thread',
        },
      ],
    });

    expect(screen.getAllByRole('button', { name: 'Copy CLI' })).toHaveLength(1);
    expect(document.querySelector('.session-menu')).toBeNull();
  });

  it('hides the resume Copy action for kimi recent threads', () => {
    renderView({
      recentSessions: [
        {
          id: 'kimi-recent',
          cwd: '/kimi',
          recencyAt: 0,
          provider: 'kimi',
          model: 'k2-thinking',
        },
        {
          id: 'codex-recent',
          cwd: '/codex',
          recencyAt: 0,
          resumeCommand: 'codex resume codex-recent',
        },
      ],
    });
    expect(document.querySelectorAll('.session-menu')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Copy to CLI' })).toHaveLength(1);
    expect(screen.getByText('Kimi')).toBeTruthy();
  });

  it('keeps a Kimi recent thread visible beside an open Codex thread with the same id', () => {
    renderView({
      sessions: [
        {
          id: 'codex-session',
          state: 'ready',
          workspacePath: '/codex',
          provider: 'codex',
          threadId: 'shared-thread',
        },
      ],
      recentSessions: [
        {
          id: 'shared-thread',
          cwd: '/kimi',
          recencyAt: 0,
          provider: 'kimi',
          model: 'k2-thinking',
        },
      ],
    });

    expect(screen.getByText('Model: k2-thinking')).toBeTruthy();
  });
});
