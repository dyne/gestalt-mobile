/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SkillsView from './SkillsView.svelte';
import { SkillsState, type SkillsClient } from './skills-state.js';

afterEach(cleanup);

const client: SkillsClient = {
  listAvailableSkills: vi.fn(),
  listSkillProfiles: vi.fn(),
  replaceSkillProfile: vi.fn(async (_name, profile) => ({ ...profile, path: '/profiles/team.yml' })),
  deleteSkillProfile: vi.fn(async () => undefined),
};

async function rendered() {
  const state = new SkillsState(client);
  state.workspaceId = 'workspace';
  state.codexProfile = 'default';
  state.skills = [{ name: 'Alpha', description: '<strong>Plain text only</strong>', displayName: 'Alpha tool', path: '/very/long/skill/path/SKILL.md', scope: 'user', nativeEnabled: false, effectiveEnabled: true, enabled: true, dependencies: { tools: [{ type: 'mcp', value: 'filesystem' }] } }];
  state.profiles = [{ version: 1, name: 'team', path: '/profiles/team.yml', skills: [] }];
  state.status = { kind: 'ready' };
  render(SkillsView, {
    workspaceTree: [{ id: 'workspace', name: 'workspace', relativePath: '.', isGitRepository: false, children: [] }],
    codexProfiles: [{ name: 'default', state: 'ok', status: 'ready' }],
    skillsState: state,
    onworkspacechange: vi.fn(),
    oncodexprofilechange: vi.fn(),
  });
  return state;
}

describe('SkillsView', () => {
  it('uses labeled native controls, path-keyed checkboxes, and safe text details', async () => {
    const state = await rendered();
    expect(screen.getByLabelText('Workspace')).toBeTruthy();
    expect(screen.getByLabelText('Codex profile')).toBeTruthy();
    expect(screen.getByLabelText('Existing saved profile')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Alpha tool/ })).toBeTruthy();
    await fireEvent.click(screen.getByText('Skill details'));
    expect(screen.getByText('<strong>Plain text only</strong>')).toBeTruthy();
    expect(screen.queryByText('Plain text only', { selector: 'strong' })).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Alpha tool/ }));
    expect(state.skills[0]?.enabled).toBe(false);
  });

  it('makes create and replace intent visible and saves a full profile', async () => {
    await rendered();
    const saveAs = screen.getByLabelText('Save as');
    await fireEvent.input(saveAs, { target: { value: 'new-team' } });
    expect(screen.getByText('Creating a new saved profile.')).toBeTruthy();
    await fireEvent.input(saveAs, { target: { value: 'team' } });
    expect(screen.getByText('Replacing the selected saved profile.')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(client.replaceSkillProfile).toHaveBeenCalledWith('team', expect.objectContaining({ version: 1, name: 'team' }));
    expect(screen.getByText('Profile saved.')).toBeTruthy();
  });
});
