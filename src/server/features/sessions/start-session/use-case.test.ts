/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { startSession } from './use-case.js';

const skills = {
  skillProfiles: {
    readGlobalProfile: async () => undefined,
    readWorkspaceDefault: async () => undefined,
  },
  skillCatalog: () => ({
    list: async () => ({
      skills: [
        { name: 'Enabled', path: '/skills/enabled/SKILL.md', enabled: true },
        { name: 'Disabled', path: '/skills/disabled/SKILL.md', enabled: false },
      ],
      errors: [],
    }),
  }),
};

describe('startSession', () => {
  it('uses Kimi-owned discovery without requiring a Codex launcher profile', async () => {
    const requiredProfiles: string[] = [];
    const catalogProviders: string[] = [];

    const result = await startSession(
      { workspaceId: 'w', profile: 'ignored-by-kimi', provider: 'kimi' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: {
          require: async (profile) => {
            requiredProfiles.push(profile);
            throw new Error('CODEX_LAUNCHER_UNAVAILABLE');
          },
        },
        skillProfiles: {
          readGlobalProfile: async () => undefined,
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: (provider) => ({
          list: async () => {
            catalogProviders.push(provider);
            return {
              skills: [{ name: 'Kimi native', path: '/kimi/SKILL.md', enabled: true }],
              errors: [],
            };
          },
        }),
        models: { list: async () => ['kimi-for-coding'] },
      },
    );

    expect(requiredProfiles).toEqual([]);
    expect(catalogProviders).toEqual(['kimi']);
    expect(result).toMatchObject({ provider: 'kimi', model: 'kimi-for-coding' });
    expect(result.effectiveSkillSelection?.skills).toEqual([
      { name: 'Kimi native', path: '/kimi/SKILL.md', enabled: true },
    ]);
  });

  it('retains Codex launcher-profile validation and its catalog', async () => {
    const requiredProfiles: string[] = [];
    const catalogProviders: string[] = [];

    await startSession(
      { workspaceId: 'w', profile: 'codex-profile', provider: 'codex' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: {
          require: async (profile) => {
            requiredProfiles.push(profile);
            return { name: profile, state: 'ok' as const, status: 'ready' as const };
          },
        },
        skillProfiles: {
          readGlobalProfile: async () => undefined,
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: (provider) => ({
          list: async () => {
            catalogProviders.push(provider);
            return { skills: [], errors: [] };
          },
        }),
      },
    );

    expect(requiredProfiles).toEqual(['codex-profile']);
    expect(catalogProviders).toEqual(['codex']);
  });

  it('creates and persists a starting session', async () => {
    const saved: unknown[] = [];
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex' },
      {
        createId: () => 's',
        now: () => 't',
        save: (session) => saved.push(session),
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        ...skills,
      },
    );
    expect(result.id).toBe('s');
    expect(result.workspacePath).toBe('/relay/workspace');
    expect(result.effectiveSkillSelection).toEqual({
      skills: [
        { name: 'Disabled', path: '/skills/disabled/SKILL.md', enabled: false },
        { name: 'Enabled', path: '/skills/enabled/SKILL.md', enabled: true },
      ],
    });
    expect(saved).toHaveLength(1);
  });

  it('captures direct Codex session settings in the durable activation snapshot', async () => {
    let received: unknown;
    const input = {
      workspaceId: 'w',
      profile: 'default',
      provider: 'codex',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    } as const;
    await startSession(input, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: {
        resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
      },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
      activate: async (session) => {
        received = session.executionPolicy;
        return session;
      },
    });

    expect(received).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('copies a selected global profile into the new session before activation', async () => {
    let activated: unknown;
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex', skillProfile: 'focused' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        skillProfiles: {
          readGlobalProfile: async () => ({
            version: 1,
            name: 'focused',
            skills: [{ name: 'Enabled', path: '/skills/enabled/SKILL.md', enabled: false }],
          }),
          readWorkspaceDefault: async () => ({
            version: 1,
            name: 'workspace',
            skills: [{ name: 'Disabled', path: '/skills/disabled/SKILL.md', enabled: true }],
          }),
        },
        skillCatalog: skills.skillCatalog,
        activate: async (session) => {
          activated = session;
          return session;
        },
      },
    );
    expect(result.effectiveSkillSelection).toEqual({
      selectedProfileName: 'focused',
      skills: [
        { name: 'Disabled', path: '/skills/disabled/SKILL.md', enabled: false },
        { name: 'Enabled', path: '/skills/enabled/SKILL.md', enabled: false },
      ],
    });
    expect(activated).toMatchObject({ effectiveSkillSelection: result.effectiveSkillSelection });
  });

  it('keeps a missing saved skill disabled without blocking session activation', async () => {
    let activated: unknown;
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex', skillProfile: 'stale' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        skillProfiles: {
          readGlobalProfile: async () => ({
            version: 1,
            name: 'stale',
            skills: [
              {
                name: 'modern-web-guidance',
                path: '/skills/modern-web-guidance/SKILL.md',
                enabled: true,
              },
            ],
          }),
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: skills.skillCatalog,
        activate: async (session) => {
          activated = session;
          return session;
        },
      },
    );

    expect(result.state).toBe('starting');
    expect(result.effectiveSkillSelection).toMatchObject({
      selectedProfileName: 'stale',
      warnings: [
        'Skill "modern-web-guidance" is missing and was disabled: /skills/modern-web-guidance/SKILL.md',
      ],
    });
    expect(result.effectiveSkillSelection?.skills).toContainEqual({
      name: 'modern-web-guidance',
      path: '/skills/modern-web-guidance/SKILL.md',
      enabled: false,
    });
    expect(activated).toBeDefined();
  });

  it('stores the requested provider on the durable session snapshot', async () => {
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        ...skills,
      },
    );
    expect(result.provider).toBe('codex');
  });

  it('rejects a model outside the requested provider catalog', async () => {
    const deps = {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: {
        resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
      },
      profiles: {
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
      },
      ...skills,
      models: {
        list: async (provider: 'codex' | 'kimi') =>
          provider === 'codex' ? ['gpt-5.6-terra'] : ['kimi-for-coding'],
      },
    };
    await expect(
      startSession(
        { workspaceId: 'w', profile: 'default', provider: 'codex', model: 'kimi-for-coding' },
        deps,
      ),
    ).rejects.toThrow('CODEX_MODEL_UNAVAILABLE');
    await expect(
      startSession(
        { workspaceId: 'w', profile: 'default', provider: 'kimi', model: 'gpt-5.6-terra' },
        deps,
      ),
    ).rejects.toThrow('KIMI_MODEL_UNAVAILABLE');
  });

  it('defaults an omitted model to the provider catalog instead of the codex default', async () => {
    const deps = {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: {
        resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
      },
      profiles: {
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
      },
      ...skills,
      models: {
        list: async (provider: 'codex' | 'kimi') =>
          provider === 'codex' ? ['gpt-5.6-terra'] : ['kimi-for-coding'],
      },
    };
    const kimi = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'kimi' },
      deps,
    );
    expect(kimi.model).toBe('kimi-for-coding');
    const codex = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex' },
      deps,
    );
    expect(codex.model).toBe('gpt-5.6-terra');
  });

  it('uses the explicit-session catalog when passive Kimi discovery is empty', async () => {
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'kimi' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        ...skills,
        models: { list: async () => [] },
        sessionModels: { list: async () => ['k2-thinking'] },
      },
    );

    expect(result).toMatchObject({ provider: 'kimi', model: 'k2-thinking' });
  });

  it('falls back to the provider first model when the relay default is unavailable', async () => {
    const result = await startSession(
      { workspaceId: 'w', profile: 'default', provider: 'codex' },
      {
        createId: () => 's',
        now: () => 't',
        save: () => {},
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: {
          require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
        },
        ...skills,
        models: { list: async () => ['gpt-5.4', 'gpt-5.6-terra-x'] },
      },
    );
    expect(result.model).toBe('gpt-5.4');
  });
});
