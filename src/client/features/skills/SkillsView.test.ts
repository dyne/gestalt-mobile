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
  state.skills = [{ name: 'Alpha', description: '<strong>Plain text only</strong>', displayName: 'Alpha tool', path: '/home/gestalt/very/long/skill/path/SKILL.md', scope: 'user', nativeEnabled: false, effectiveEnabled: true, enabled: true, dependencies: { tools: [{ type: 'mcp', value: 'filesystem' }] } }];
  state.profiles = [{ version: 1, name: 'team', path: '/profiles/team.yml', skills: [] }];
  state.status = { kind: 'ready' };
  render(SkillsView, {
    skillsState: state,
    onrefresh: vi.fn(async () => undefined),
    onprofileschange: vi.fn(),
  });
  return state;
}

describe('SkillsView', () => {
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
    Object.defineProperty(card, 'scrollIntoView', { value: scrollIntoView });

    await fireEvent.focus(checkbox);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
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

  it('offers an explicit delete confirmation only for a selected saved profile', async () => {
    await rendered();
    const deleteButton = screen.getByRole('button', { name: 'Delete profile' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    await fireEvent.change(screen.getByLabelText('Skill profile'), { target: { value: 'team' } });
    expect(deleteButton.disabled).toBe(false);
  });
});
