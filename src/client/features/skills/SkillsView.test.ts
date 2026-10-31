/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RelaySkillProfile } from '../sessions/relay-client.js';
import SkillsView from './SkillsView.svelte';
import { SkillsState, type SkillsClient } from './skills-state.js';

afterEach(cleanup);

const client: SkillsClient = {
  listAvailableSkills: vi.fn(),
  listSkillProfiles: vi.fn(),
  replaceSkillProfile: vi.fn(async (_name, profile) => ({
    ...profile,
    path: '/profiles/team.yml',
  })),
  deleteSkillProfile: vi.fn(async () => undefined),
};

async function rendered() {
  const state = new SkillsState(client);
  state.workspaceId = 'workspace';
  state.codexProfile = 'default';
  state.skills = [
    {
      name: 'Alpha',
      description: '<strong>Plain text only</strong>',
      displayName: 'Alpha tool',
      path: '/home/gestalt/very/long/skill/path/SKILL.md',
      scope: 'user',
      nativeEnabled: false,
      effectiveEnabled: true,
      alwaysAdvertised: false,
      enabled: true,
      dependencies: { tools: [{ type: 'mcp', value: 'filesystem' }] },
    },
  ];
  state.profiles = [{ version: 1, name: 'team', path: '/profiles/team.yml', skills: [] }];
  state.status = { kind: 'ready' };
  render(SkillsView, {
    skillsState: state,
    onrefresh: vi.fn(async () => undefined),
    onprofileschange: vi.fn(),
  });
  return state;
}

async function renderedAlwaysAdvertised() {
  const state = new SkillsState(client);
  state.skills = [
    {
      name: 'gestalt:org-plan',
      path: '/plugins/gestalt/skills/org-plan/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: true,
      enabled: true,
    },
  ];
  state.status = { kind: 'ready' };
  render(SkillsView, {
    skillsState: state,
    onrefresh: vi.fn(async () => undefined),
    onprofileschange: vi.fn(),
  });
  return state;
}

describe('SkillsView', () => {
  it('badges only verified optional skills and preserves count, disable, save and reload', async () => {
    const verified = {
      name: 'nuklear-gui',
      displayName: 'Nuklear GUI development with deliberately long wrapped guidance',
      path: '/home/gestalt/collection/with/a/very/long/path/nuklear-gui/SKILL.md',
      description: 'Long metadata remains plain text alongside the optional selection.',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: false,
      provenance: {
        kind: 'gestalt-verified' as const,
        repository: 'dyne/gestalt-skills' as const,
        revision: 'a'.repeat(40),
      },
    };
    const ordinary = {
      name: 'local-control',
      path: '/skills/local-control/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: false,
    };
    let profiles: RelaySkillProfile[] = [];
    const replaceSkillProfile = vi.fn(async (_name, profile) => {
      const saved = { ...profile, path: '/profiles/verified.yml' };
      profiles = [saved];
      return saved;
    });
    const skillsClient: SkillsClient = {
      ...client,
      listAvailableSkills: vi.fn(async () => ({
        source: 'native' as const,
        errors: [],
        skills: [
          verified,
          ordinary,
          {
            ...verified,
            name: 'gestalt:org-plan',
            path: '/plugins/org-plan/SKILL.md',
            alwaysAdvertised: true,
          },
        ],
      })),
      listSkillProfiles: vi.fn(async () => ({ profiles })),
      replaceSkillProfile,
    };
    const state = new SkillsState(skillsClient);
    await state.load('workspace', 'default');
    const props = {
      skillsState: state,
      onrefresh: async () => state.refresh(),
      onprofileschange: vi.fn(),
    };
    render(SkillsView, props);
    const toggle = screen.getByRole('checkbox', { name: /Nuklear GUI.*Gestalt verified.*Enabled/ });
    expect((toggle as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByText('Gestalt verified')).toHaveLength(1);
    expect(screen.queryByText('gestalt:org-plan')).toBeNull();
    expect(
      within(screen.getByRole('checkbox', { name: /local-control/ }).closest('li')!).queryByText(
        'Gestalt verified',
      ),
    ).toBeNull();
    expect(screen.getByText('2 of 2 skills enabled.')).toBeTruthy();
    expect(
      screen.getByText('~/collection/with/a/very/long/path/nuklear-gui/SKILL.md'),
    ).toBeTruthy();
    await fireEvent.click(toggle);
    expect(screen.getByText('1 of 2 skills enabled.')).toBeTruthy();
    expect(screen.getAllByText('Gestalt verified')).toHaveLength(1);
    await fireEvent.input(screen.getByLabelText('Save as'), { target: { value: 'verified' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(replaceSkillProfile).toHaveBeenCalledWith('verified', {
      version: 1,
      name: 'verified',
      skills: [
        { name: verified.name, path: verified.path, enabled: false },
        { name: ordinary.name, path: ordinary.path, enabled: true },
      ],
    });
    cleanup();
    const reloaded = new SkillsState(skillsClient);
    await reloaded.load('workspace', 'default');
    render(SkillsView, { ...props, skillsState: reloaded });
    await fireEvent.change(screen.getByLabelText('Skill profile'), {
      target: { value: 'verified' },
    });
    expect(
      (
        screen.getByRole('checkbox', {
          name: /Nuklear GUI.*Gestalt verified.*Disabled/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.getByText('1 of 2 skills enabled.')).toBeTruthy();
  });

  it('refreshes current editor provenance after profile selection without discarding local edits', async () => {
    const verified = {
      name: 'nuklear-gui',
      path: '/managed/nuklear-gui/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: false,
      provenance: {
        kind: 'gestalt-verified' as const,
        repository: 'dyne/gestalt-skills' as const,
        revision: 'a'.repeat(40),
      },
    };
    const ordinary = {
      name: 'local-control',
      path: '/skills/local-control/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: false,
    };
    let intact = true;
    const skillsClient: SkillsClient = {
      ...client,
      listAvailableSkills: vi.fn(async () => ({
        source: 'native' as const,
        errors: [],
        skills: [{ ...verified, provenance: intact ? verified.provenance : undefined }, ordinary],
      })),
      listSkillProfiles: vi.fn(async () => ({
        profiles: [
          {
            version: 1 as const,
            name: 'saved',
            path: '/profiles/saved.yml',
            skills: [
              { name: verified.name, path: verified.path, enabled: false },
              { name: ordinary.name, path: ordinary.path, enabled: true },
            ],
          },
        ],
      })),
    };
    const state = new SkillsState(skillsClient);
    await state.load('workspace', 'default');
    const onrefresh = vi.fn(async (editor = state) => editor.refresh());
    render(SkillsView, { skillsState: state, onrefresh, onprofileschange: vi.fn() });
    await fireEvent.change(screen.getByLabelText('Skill profile'), { target: { value: 'saved' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /local-control/ }));
    expect(screen.getByText('0 of 2 skills enabled.')).toBeTruthy();
    intact = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
    expect(screen.queryByText('Gestalt verified')).toBeNull();
    expect(
      (screen.getByRole('checkbox', { name: /nuklear-gui/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: /local-control/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText('0 of 2 skills enabled.')).toBeTruthy();
    intact = true;
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
    expect(screen.getByText('Gestalt verified')).toBeTruthy();
    expect(screen.getByText('0 of 2 skills enabled.')).toBeTruthy();
  });

  it('leaves a managed-looking skill plain when provenance is absent', async () => {
    const state = await rendered();
    state.skills[0]!.name = 'nuklear-gui';
    state.skills[0]!.path =
      '/home/gestalt/.codex-gestalt/gestalt-skills/skills/nuklear-gui/SKILL.md';
    cleanup();
    render(SkillsView, {
      skillsState: state,
      onrefresh: vi.fn(async () => undefined),
      onprofileschange: vi.fn(),
    });
    expect(screen.queryByText('Gestalt verified')).toBeNull();
    expect(
      (screen.getByRole('checkbox', { name: /Alpha tool/ }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('labels browser consent separately, defaults off, and explains unavailable host access', async () => {
    const state = await rendered();
    const toggle = screen.getByRole('checkbox', { name: 'Browser access (Playwright)' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Off · browser access disabled')).toBeTruthy();
    await fireEvent.click(toggle);
    expect(state.playwrightEnabled).toBe(true);
    expect(screen.getByText('Configured · runtime unavailable')).toBeTruthy();
    expect(screen.getByText(/Kimi cannot use this capability/)).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Save as'), { target: { value: 'browser' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(client.replaceSkillProfile).toHaveBeenCalledWith(
      'browser',
      expect.objectContaining({ version: 2, capabilities: { playwright: { enabled: true } } }),
    );
  });

  it('uses a profile selector, path-keyed checkboxes, and compact safe skill details', async () => {
    const state = await rendered();
    expect(screen.getByLabelText('Skill profile')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Default' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Alpha tool/ })).toBeTruthy();
    expect(screen.getByText('<strong>Plain text only</strong>')).toBeTruthy();
    expect(screen.queryByText('Plain text only', { selector: 'strong' })).toBeNull();
    expect(screen.getByText('~/very/long/skill/path/SKILL.md')).toBeTruthy();
    expect(screen.queryByText('Scope')).toBeNull();
    expect(screen.queryByText('Native state')).toBeNull();
    expect(screen.queryByText('Display metadata')).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Alpha tool/ }));
    expect(state.skills[0]?.enabled).toBe(false);
  });

  it('reveals the complete skill card when its checkbox receives keyboard focus', async () => {
    await rendered();
    const checkbox = screen.getByRole('checkbox', { name: /Alpha tool/ });
    const card = checkbox.closest('.skill-card') as HTMLElement;
    const scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(card, 'scrollIntoView', { value: scrollIntoView });

    checkbox.focus();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    vi.unstubAllGlobals();
  });

  it.each(['focus moved to Save', 'checkbox detached'])(
    'does not scroll an old skill card after %s before the next frame',
    async (change) => {
      await rendered();
      const checkbox = screen.getByRole('checkbox', { name: /Alpha tool/ });
      const card = checkbox.closest('.skill-card') as HTMLElement;
      const scrollIntoView = vi.fn();
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      Object.defineProperty(card, 'scrollIntoView', { value: scrollIntoView });
      try {
        checkbox.focus();
        expect(frames).toHaveLength(1);
        if (change === 'focus moved to Save')
          screen.getByRole('button', { name: 'Save profile' }).focus();
        else checkbox.remove();

        for (const frame of frames) frame(0);

        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('labels Gestalt infrastructure skills and does not offer a disable control', async () => {
    await renderedAlwaysAdvertised();
    const checkbox = screen.getByRole('checkbox', { name: /gestalt:org-plan/ });

    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Always advertised')).toBeTruthy();
    expect(screen.queryByText('Gestalt verified')).toBeNull();
  });

  it('highlights a missing disabled skill and removes it from the selected profile', async () => {
    const state = await rendered();
    state.missingSkills = [
      {
        name: 'modern-web-guidance',
        path: '/home/gestalt/.agents/skills/modern-web-guidance/SKILL.md',
        enabled: false,
      },
    ];
    state.status = {
      kind: 'warning',
      message: '1 saved skill is missing and disabled.',
    };
    cleanup();
    render(SkillsView, {
      skillsState: state,
      onrefresh: vi.fn(async () => undefined),
      onprofileschange: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'Missing skills' })).toBeTruthy();
    expect(screen.getByText('Missing · disabled')).toBeTruthy();
    expect(screen.getByText('~/.agents/skills/modern-web-guidance/SKILL.md')).toBeTruthy();

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove missing skill modern-web-guidance from profile',
      }),
    );
    expect(state.missingSkills).toEqual([]);
  });

  it('makes create and replace intent visible and saves a full profile', async () => {
    await rendered();
    const saveAs = screen.getByLabelText('Save as');
    await fireEvent.change(screen.getByLabelText('Skill profile'), { target: { value: 'team' } });
    expect((saveAs as HTMLInputElement).value).toBe('team');
    expect(screen.getByText('Saved the selected profile.')).toBeTruthy();
    await fireEvent.input(saveAs, { target: { value: 'new-team' } });
    expect(screen.getByText('Creating a new saved profile.')).toBeTruthy();
    await fireEvent.input(saveAs, { target: { value: 'team' } });
    expect(screen.getByText('Saved the selected profile.')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(client.replaceSkillProfile).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ version: 1, name: 'team' }),
    );
    expect(screen.getByText('Profile saved.')).toBeTruthy();
  });

  it('offers an explicit delete confirmation only for a selected saved profile', async () => {
    await rendered();
    const deleteButton = screen.getByRole('button', {
      name: 'Delete profile',
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    await fireEvent.change(screen.getByLabelText('Skill profile'), { target: { value: 'team' } });
    expect(deleteButton.disabled).toBe(false);
  });
});
