/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { SkillsState, type SkillsClient } from './skills-state.js';

const available = {
  source: 'native' as const,
  errors: [],
  skills: [
    { name: 'Alpha', path: '/skills/alpha/SKILL.md', nativeEnabled: true, effectiveEnabled: true },
    { name: 'Alpha', path: '/skills/beta/SKILL.md', nativeEnabled: false, effectiveEnabled: false },
  ],
};

function client(overrides: Partial<SkillsClient> = {}): SkillsClient {
  return {
    listAvailableSkills: vi.fn(async () => available),
    listSkillProfiles: vi.fn(async () => ({ profiles: [] })),
    replaceSkillProfile: vi.fn(async (_name, profile) => ({ ...profile, path: '/profiles/new.yml' })),
    ...overrides,
  };
}

describe('SkillsState', () => {
  it('loads path-keyed skills and prepares a complete deterministic save payload', async () => {
    const state = new SkillsState(client());
    await state.load('workspace/a', 'default');
    state.toggle('/skills/beta/SKILL.md', true);
    state.saveAsName = 'team';

    expect(state.status).toEqual({ kind: 'ready' });
    expect(state.enabledCount).toBe(2);
    expect(state.dirty).toBe(true);
    expect(state.saveIntent).toBe('create');
    expect(state.savePayload()).toEqual({
      version: 1,
      name: 'team',
      skills: [
        { name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true },
        { name: 'Alpha', path: '/skills/beta/SKILL.md', enabled: true },
      ],
    });
  });

  it('loads an existing profile, resets local changes, and distinguishes replace intent', async () => {
    const state = new SkillsState(
      client({
        listSkillProfiles: vi.fn(async () => ({
          profiles: [{ version: 1 as const, name: 'team', path: '/profiles/team.yml', skills: [{ name: 'Alpha', path: '/skills/beta/SKILL.md', enabled: true }] }],
        })),
      }),
    );
    await state.load('workspace', 'default');
    state.selectProfile('team');
    state.toggle('/skills/beta/SKILL.md', false);
    state.reset();

    expect(state.saveAsName).toBe('team');
    expect(state.saveIntent).toBe('replace');
    expect(state.skills.find((skill) => skill.path.endsWith('beta/SKILL.md'))?.enabled).toBe(true);
    expect(state.dirty).toBe(false);
  });

  it('suppresses concurrent saves and preserves a save failure for the view', async () => {
    let resolveSave: ((value: { version: 1; name: string; path: string; skills: Array<{ name: string; path: string; enabled: boolean }> }) => void) | undefined;
    const state = new SkillsState(
      client({
        replaceSkillProfile: vi.fn(
          () => new Promise((resolve: (value: { version: 1; name: string; path: string; skills: Array<{ name: string; path: string; enabled: boolean }> }) => void) => { resolveSave = resolve; }),
        ),
      }),
    );
    await state.load('workspace', 'default');
    state.saveAsName = 'new';
    const first = state.save();
    const second = state.save();
    resolveSave?.({ version: 1, name: 'new', path: '/profiles/new.yml', skills: [] });
    await Promise.all([first, second]);

    expect(state.status).toEqual({ kind: 'saved' });
  });

  it('keeps explicit toggles when discovery refreshes and reports warning and errors', async () => {
    const state = new SkillsState(client());
    await state.load('workspace', 'default');
    state.toggle('/skills/beta/SKILL.md', true);
    const refreshed = { ...available, errors: [{ message: 'One scope was unavailable.' }] };
    const testClient = client({ listAvailableSkills: vi.fn(async () => refreshed) });
    (state as unknown as { client: SkillsClient }).client = testClient;
    await state.load('workspace', 'default');

    expect(state.skills.find((skill) => skill.path.endsWith('beta/SKILL.md'))?.enabled).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.status).toEqual({ kind: 'warning', message: 'One scope was unavailable.' });
  });
});
