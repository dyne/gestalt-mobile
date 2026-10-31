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
    {
      name: 'Alpha',
      path: '/skills/alpha/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: false,
    },
    {
      name: 'Alpha',
      path: '/skills/beta/SKILL.md',
      nativeEnabled: false,
      effectiveEnabled: false,
      alwaysAdvertised: false,
    },
  ],
};

function client(overrides: Partial<SkillsClient> = {}): SkillsClient {
  return {
    listAvailableSkills: vi.fn(async () => available),
    listSkillProfiles: vi.fn(async () => ({ profiles: [] })),
    replaceSkillProfile: vi.fn(async (_name, profile) => ({
      ...profile,
      path: '/profiles/new.yml',
    })),
    deleteSkillProfile: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('SkillsState', () => {
  it('preserves explicit missing-row removal across refresh and save, and reset restores the saved row', async () => {
    const missing = { name: 'nuklear-gui', path: '/managed/nuklear-gui/SKILL.md', enabled: false };
    const saved = {
      version: 1 as const,
      name: 'work',
      path: '/profiles/work.yml',
      skills: [missing],
    };
    const state = new SkillsState(
      client({
        listAvailableSkills: async () => ({ ...available, skills: [] }),
        listSkillProfiles: async () => ({ profiles: [saved] }),
      }),
    );
    await state.load('w', 'default');
    state.selectProfile('work');
    state.removeMissingSkill(missing.path);
    await state.refresh();
    expect(state.missingSkills).toEqual([]);
    expect(state.savePayload().skills).toEqual([]);
    expect(state.dirty).toBe(true);
    state.reset();
    expect(state.missingSkills).toEqual([missing]);
    expect(state.dirty).toBe(false);
    state.removeMissingSkill(missing.path);
    await state.save();
    await state.refresh();
    expect(state.missingSkills).toEqual([]);
    expect(state.savePayload().skills).toEqual([]);
    expect(state.dirty).toBe(false);
  });

  it('warns about newly missing paths without resurrecting a different explicitly removed row', async () => {
    const absent = { name: 'absent', path: '/missing/SKILL.md', enabled: false };
    const saved = {
      version: 1 as const,
      name: 'work',
      path: '/profiles/work.yml',
      skills: [
        absent,
        { name: available.skills[0].name, path: available.skills[0].path, enabled: false },
      ],
    };
    const state = new SkillsState(
      client({
        listAvailableSkills: vi
          .fn()
          .mockResolvedValueOnce({ ...available, skills: [available.skills[0]] })
          .mockResolvedValueOnce({ ...available, skills: [] }),
        listSkillProfiles: async () => ({ profiles: [saved] }),
      }),
    );
    await state.load('w', 'default');
    state.selectProfile('work');
    state.removeMissingSkill(absent.path);
    await state.refresh();
    expect(state.missingSkills).toEqual([saved.skills[1]]);
    expect(state.status.kind).toBe('warning');
    expect(state.dirty).toBe(true);
    state.reset();
    expect(state.missingSkills.map((skill) => skill.path).sort()).toEqual(
      saved.skills.map((skill) => skill.path).sort(),
    );
    expect(state.dirty).toBe(false);
  });

  it.each([true, false])(
    'restores a returned path without duplicate missing rows and resets removed=%s intent',
    async (remove) => {
      const managed = {
        ...available.skills[0],
        name: 'nuklear-gui',
        path: '/managed/nuklear-gui/SKILL.md',
      };
      const saved = {
        version: 1 as const,
        name: 'work',
        path: '/profiles/work.yml',
        skills: [{ name: managed.name, path: managed.path, enabled: true }],
      };
      const state = new SkillsState(
        client({
          listAvailableSkills: vi
            .fn()
            .mockResolvedValueOnce({ ...available, skills: [] })
            .mockResolvedValue({ ...available, skills: [managed] }),
          listSkillProfiles: async () => ({ profiles: [saved] }),
        }),
      );
      await state.load('w', 'default');
      state.selectProfile('work');
      if (remove) state.removeMissingSkill(managed.path);
      await state.refresh();
      expect(state.missingSkills).toEqual([]);
      expect(state.skills[0].enabled).toBe(false);
      expect(state.dirty).toBe(true);
      state.reset();
      expect(state.missingSkills).toEqual([]);
      expect(state.skills[0].enabled).toBe(true);
      expect(state.dirty).toBe(false);
      await state.refresh();
      expect(state.savePayload().skills).toEqual(saved.skills);
      expect(state.dirty).toBe(false);
    },
  );
  it('retains saved disabled choices and excludes update-added paths when refreshing a selected complete profile', async () => {
    const managed = {
      ...available.skills[0],
      name: 'nuklear-gui',
      path: '/codex/gestalt-skills/skills/nuklear-gui/SKILL.md',
    };
    const added = {
      ...available.skills[1],
      name: 'new-skill',
      path: '/codex/gestalt-skills/skills/new-skill/SKILL.md',
      effectiveEnabled: true,
    };
    const saved = {
      version: 1 as const,
      name: 'work',
      path: '/profiles/work.yml',
      skills: [{ name: managed.name, path: managed.path, enabled: false }],
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ...available, skills: [managed] })
      .mockResolvedValueOnce({ ...available, skills: [managed, added] })
      .mockResolvedValueOnce({ ...available, skills: [added] });
    const api = client({
      listAvailableSkills: list,
      listSkillProfiles: async () => ({ profiles: [saved] }),
    });
    const state = new SkillsState(api);
    await state.load('w', 'default');
    state.selectProfile('work');
    await state.refresh();
    expect(state.skills.map(({ path, enabled }) => ({ path, enabled }))).toEqual([
      { path: managed.path, enabled: false },
      { path: added.path, enabled: false },
    ]);
    state.toggle(added.path, true);
    await state.refresh();
    expect(state.skills[0].enabled).toBe(true);
    expect(state.missingSkills).toEqual([
      { name: managed.name, path: managed.path, enabled: false },
    ]);
    state.saveAsName = 'work';
    await state.save();
    const reload = new SkillsState(
      client({
        listAvailableSkills: async () => ({ ...available, skills: [added] }),
        listSkillProfiles: async () => ({ profiles: state.profiles }),
      }),
    );
    await reload.load('w', 'default');
    reload.selectProfile('work');
    expect(reload.skills[0].enabled).toBe(true);
    expect(reload.missingSkills[0].enabled).toBe(false);
  });
  it('refreshes provenance independently from path-keyed edits and excludes it from saved profiles', async () => {
    const provenance = {
      kind: 'gestalt-verified' as const,
      repository: 'dyne/gestalt-skills' as const,
      revision: 'a'.repeat(40),
    };
    const api = client({
      listAvailableSkills: vi
        .fn()
        .mockResolvedValueOnce({
          ...available,
          skills: [{ ...available.skills[0], provenance }, available.skills[1]],
        })
        .mockResolvedValueOnce(available),
    });
    const state = new SkillsState(api);
    await state.load('w', 'default');
    expect(state.skills[0].provenance).toEqual(provenance);
    expect(state.skills[1].provenance).toBeUndefined();
    state.toggle(state.skills[0].path, false);
    expect(state.savePayload('work').skills).toEqual(
      available.skills.map(({ name, path }) => ({ name, path, enabled: false })),
    );
    await state.refresh();
    expect(state.skills[0].provenance).toBeUndefined();
    expect(state.skills[0].enabled).toBe(false);
    expect(state.skills[1].enabled).toBe(false);
    expect(state.dirty).toBe(true);
  });
  it('defaults browser access off and retains explicit choices through save, duplicate, reload and delete', async () => {
    const api = client();
    const state = new SkillsState(api);
    await state.load('w', 'default');
    expect(state.playwrightEnabled).toBe(false);
    expect(state.savePayload().version).toBe(1);
    state.setPlaywrightEnabled(true);
    expect(state.dirty).toBe(true);
    state.saveAsName = 'browser';
    await state.save();
    expect(state.savePayload()).toMatchObject({
      version: 2,
      capabilities: { playwright: { enabled: true } },
    });
    expect(state.dirty).toBe(false);
    state.saveAsName = 'copy';
    await state.save();
    state.selectDefaultProfile();
    expect(state.playwrightEnabled).toBe(false);
    state.selectProfile('copy');
    expect(state.playwrightEnabled).toBe(true);
    state.setPlaywrightEnabled(false);
    await state.save();
    state.selectProfile('browser');
    expect(state.playwrightEnabled).toBe(true);
    state.selectProfile('copy');
    expect(state.playwrightEnabled).toBe(false);
    expect(state.savePayload()).toMatchObject({
      version: 2,
      capabilities: { playwright: { enabled: false } },
    });
    await state.deleteSelectedProfile();
    expect(state.playwrightEnabled).toBe(false);
    expect(state.profiles.some((profile) => profile.name === 'browser')).toBe(true);
  });

  it('loads workspace consent, preserves browser edits during refresh, and resets the baseline', async () => {
    const state = new SkillsState(
      client({
        listAvailableSkills: vi.fn(async () => ({
          ...available,
          source: 'project' as const,
          capabilities: { playwright: { enabled: true } },
        })),
      }),
    );
    await state.load('w', 'default');
    expect(state.playwrightEnabled).toBe(true);
    state.setPlaywrightEnabled(false);
    await state.refresh();
    expect(state.playwrightEnabled).toBe(false);
    state.reset();
    expect(state.playwrightEnabled).toBe(true);
  });

  it('reports failed saves to the shared error callback and preserves browser edits', async () => {
    const onerror = vi.fn();
    const state = new SkillsState(
      client({
        replaceSkillProfile: vi.fn(async () => {
          throw new Error('Disk unavailable. Try again.');
        }),
      }),
      onerror,
    );
    state.setPlaywrightEnabled(true);
    state.saveAsName = 'browser';
    await state.save();
    expect(onerror).toHaveBeenCalledWith('Disk unavailable. Try again.');
    expect(state.playwrightEnabled).toBe(true);
    expect(state.status.kind).toBe('save-failed');
  });

  it('discovers skills when the profile manager is opened', async () => {
    const listAvailableSkills = vi.fn(async () => available);
    const state = new SkillsState(client({ listAvailableSkills }));

    await state.load('workspace/a', 'default');

    expect(listAvailableSkills).toHaveBeenCalledWith(
      'workspace/a',
      'default',
      true,
      expect.any(AbortSignal),
    );
    expect(state.status).toEqual({ kind: 'ready' });
  });

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
          profiles: [
            {
              version: 1 as const,
              name: 'team',
              path: '/profiles/team.yml',
              skills: [{ name: 'Alpha', path: '/skills/beta/SKILL.md', enabled: true }],
            },
          ],
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

  it('shows missing profile skills as disabled until they are removed and saved', async () => {
    const replaceSkillProfile = vi.fn(async (_name, profile) => ({
      ...profile,
      path: '/profiles/stale.yml',
    }));
    const state = new SkillsState(
      client({
        listSkillProfiles: vi.fn(async () => ({
          profiles: [
            {
              version: 1 as const,
              name: 'stale',
              path: '/profiles/stale.yml',
              skills: [
                {
                  name: 'modern-web-guidance',
                  path: '/skills/modern-web-guidance/SKILL.md',
                  enabled: true,
                },
              ],
            },
          ],
        })),
        replaceSkillProfile,
      }),
    );

    await state.load('workspace', 'default');
    state.selectProfile('stale');

    expect(state.missingSkills).toEqual([
      {
        name: 'modern-web-guidance',
        path: '/skills/modern-web-guidance/SKILL.md',
        enabled: false,
      },
    ]);
    expect(state.status).toMatchObject({ kind: 'warning' });
    expect(state.dirty).toBe(true);
    expect(state.savePayload().skills).toContainEqual({
      name: 'modern-web-guidance',
      path: '/skills/modern-web-guidance/SKILL.md',
      enabled: false,
    });

    state.removeMissingSkill('/skills/modern-web-guidance/SKILL.md');
    await state.save();

    expect(replaceSkillProfile).toHaveBeenCalledWith(
      'stale',
      expect.objectContaining({
        skills: expect.not.arrayContaining([
          expect.objectContaining({ path: '/skills/modern-web-guidance/SKILL.md' }),
        ]),
      }),
    );
  });

  it('omits mandatory Gestalt infrastructure from legacy catalogs and saved profiles', async () => {
    const gestaltSkill = {
      name: 'gestalt:org-plan',
      path: '/plugins/gestalt/skills/org-plan/SKILL.md',
      nativeEnabled: true,
      effectiveEnabled: true,
      alwaysAdvertised: true,
    };
    const state = new SkillsState(
      client({
        listAvailableSkills: vi.fn(async () => ({
          source: 'native' as const,
          errors: [],
          skills: [gestaltSkill],
        })),
        listSkillProfiles: vi.fn(async () => ({
          profiles: [
            {
              version: 1 as const,
              name: 'old',
              path: '/profiles/old.yml',
              skills: [{ name: gestaltSkill.name, path: gestaltSkill.path, enabled: false }],
            },
          ],
        })),
      }),
    );

    await state.load('workspace', 'default');
    state.selectProfile('old');

    expect(state.skills).toEqual([]);
    expect(state.missingSkills).toEqual([]);
    expect(state.savePayload('old').skills).toEqual([]);
  });

  it('suppresses concurrent saves and preserves a save failure for the view', async () => {
    let resolveSave:
      | ((value: {
          version: 1;
          name: string;
          path: string;
          skills: Array<{ name: string; path: string; enabled: boolean }>;
        }) => void)
      | undefined;
    const state = new SkillsState(
      client({
        replaceSkillProfile: vi.fn(
          () =>
            new Promise(
              (
                resolve: (value: {
                  version: 1;
                  name: string;
                  path: string;
                  skills: Array<{ name: string; path: string; enabled: boolean }>;
                }) => void,
              ) => {
                resolveSave = resolve;
              },
            ),
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

  it('deletes the selected profile once and returns to an unsaved selection', async () => {
    let resolveDelete: (() => void) | undefined;
    const deleteSkillProfile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const state = new SkillsState(
      client({
        listSkillProfiles: vi.fn(async () => ({
          profiles: [{ version: 1 as const, name: 'team', path: '/profiles/team.yml', skills: [] }],
        })),
        deleteSkillProfile,
      }),
    );
    await state.load('workspace', 'default');
    state.selectProfile('team');
    const first = state.deleteSelectedProfile();
    const second = state.deleteSelectedProfile();
    resolveDelete?.();
    await Promise.all([first, second]);

    expect(deleteSkillProfile).toHaveBeenCalledTimes(1);
    expect(state.profiles).toEqual([]);
    expect(state.selectedProfileName).toBe('');
    expect(state.saveAsName).toBe('');
    expect(state.status).toEqual({ kind: 'deleted' });
  });

  it('keeps local profile choices when deletion fails', async () => {
    const state = new SkillsState(
      client({
        listSkillProfiles: vi.fn(async () => ({
          profiles: [{ version: 1 as const, name: 'team', path: '/profiles/team.yml', skills: [] }],
        })),
        deleteSkillProfile: vi.fn(async () => {
          throw new Error('Profile deletion failed.');
        }),
      }),
    );
    await state.load('workspace', 'default');
    state.selectProfile('team');
    await state.deleteSelectedProfile();

    expect(state.profiles).toHaveLength(1);
    expect(state.selectedProfileName).toBe('team');
    expect(state.status).toEqual({ kind: 'delete-failed', message: 'Profile deletion failed.' });
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

  it('does not publish a stale profile load after a newer workspace selection', async () => {
    const resolvers: Array<(value: typeof available) => void> = [];
    const state = new SkillsState(
      client({
        listAvailableSkills: vi.fn(
          () => new Promise<typeof available>((resolve) => resolvers.push(resolve)),
        ),
      }),
    );
    const first = state.load('first', 'default');
    const second = state.load('second', 'default');
    resolvers[0]?.(available);
    await first;
    expect(state.workspaceId).toBe('second');
    expect(state.skills).toEqual([]);
    resolvers[1]?.(available);
    await second;
    expect(state.workspaceId).toBe('second');
    expect(state.status).toEqual({ kind: 'ready' });
  });
});

it('hides Serena and drops legacy profile choices through discovery and save', async () => {
  const skill = {
    name: 'gestalt:serena',
    path: '/plugins/gestalt/skills/serena/SKILL.md',
    nativeEnabled: true,
    effectiveEnabled: true,
    alwaysAdvertised: false,
  };
  const state = new SkillsState(
    client({
      listAvailableSkills: async () => ({ source: 'native', errors: [], skills: [skill] }),
      listSkillProfiles: async () => ({
        profiles: [
          {
            version: 1,
            name: 'semantic',
            path: '/profiles/semantic.yml',
            skills: [{ name: skill.name, path: skill.path, enabled: true }],
          },
        ],
      }),
    }),
  );
  await state.load('workspace', 'default');
  state.selectProfile('semantic');
  expect(state.skills).toEqual([]);
  expect(state.missingSkills).toEqual([]);
  state.toggle(skill.path, false);
  expect(state.savePayload('semantic').skills).toEqual([]);
  await state.refresh();
  expect(state.skills).toEqual([]);
});
