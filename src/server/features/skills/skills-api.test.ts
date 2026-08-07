/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerListAvailableSkills } from './list-available/endpoint.js';
import { registerListSkillProfiles } from './list-profiles/endpoint.js';
import { registerReplaceSkillProfile } from './replace-profile/endpoint.js';
import { registerDeleteSkillProfile } from './delete-profile/endpoint.js';

describe('skills REPR endpoints', () => {
  it('maps a workspace catalog to documented effective state without contents', async () => {
    const app = fastify();
    registerListAvailableSkills(app, {
      workspaces: { resolve: async () => ({ id: 'opaque', name: 'work', realPath: '/workspace' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      catalog: {
        list: async () => ({
          skills: [
            { name: 'Same', path: '/skills/b/SKILL.md', enabled: true, description: 'b' },
            { name: 'Same', path: '/skills/a/SKILL.md', enabled: false, description: 'a' },
          ],
          errors: [{ message: 'manifest warning' }],
        }),
        refresh: async () => ({ skills: [], errors: [] }),
      },
      selections: {
        readWorkspaceDefault: async () => ({
          version: 1,
          name: 'project',
          skills: [{ name: 'Same', path: '/skills/a/SKILL.md', enabled: true }],
        }),
      },
    });
    const response = await app.inject('/api/skills?workspaceId=opaque&profile=default');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      source: 'project',
      errors: [{ message: 'manifest warning' }],
      skills: [
        {
          name: 'Same',
          description: 'a',
          path: '/skills/a/SKILL.md',
          nativeEnabled: false,
          effectiveEnabled: true,
        },
        {
          name: 'Same',
          description: 'b',
          path: '/skills/b/SKILL.md',
          nativeEnabled: true,
          effectiveEnabled: false,
        },
      ],
    });
    await app.close();
  });

  it('lists valid and corrupt profiles independently and atomically replaces a profile', async () => {
    const app = fastify();
    const profiles = new Map<
      string,
      { version: 1; name: string; skills: Array<{ name: string; path: string; enabled: boolean }> }
    >();
    const deps = {
      listGlobalProfileNames: async () => ['broken', 'work'],
      readGlobalProfile: async (name: string) => {
        if (name === 'broken') throw new Error('bad yaml');
        return profiles.get(name);
      },
      replaceGlobalProfile: async (profile: {
        version: 1;
        name: string;
        skills: Array<{ name: string; path: string; enabled: boolean }>;
      }) => {
        profiles.set(profile.name, profile);
      },
      profilePath: (name: string) => `/home/test/.gestalt/skill-profiles/${name}.yml`,
    };
    profiles.set('work', { version: 1, name: 'work', skills: [] });
    registerListSkillProfiles(app, deps);
    registerReplaceSkillProfile(app, deps);
    registerDeleteSkillProfile(app, {
      deleteGlobalProfile: async (name) => profiles.delete(name),
    });
    expect((await app.inject('/api/skill-profiles')).json()).toEqual({
      profiles: [
        {
          name: 'broken',
          path: '/home/test/.gestalt/skill-profiles/broken.yml',
          error: { code: 'INVALID_SKILL_PROFILE', message: 'bad yaml' },
        },
        {
          name: 'work',
          version: 1,
          path: '/home/test/.gestalt/skill-profiles/work.yml',
          skills: [],
        },
      ],
    });
    const replaced = await app.inject({
      method: 'PUT',
      url: '/api/skill-profiles/new',
      payload: {
        version: 1,
        name: 'new',
        skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true }],
      },
    });
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json()).toMatchObject({
      name: 'new',
      path: '/home/test/.gestalt/skill-profiles/new.yml',
    });
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/skill-profiles/work' })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/skill-profiles/work' })).json(),
    ).toMatchObject({ code: 'SKILL_PROFILE_NOT_FOUND' });
    await app.close();
  });

  it('maps unsafe names and storage failures without any session dependency', async () => {
    const app = fastify();
    registerDeleteSkillProfile(app, {
      deleteGlobalProfile: async () => {
        throw new Error('disk offline');
      },
    });
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/skill-profiles/work%2Fother' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/skill-profiles/work' })).json(),
    ).toMatchObject({ code: 'SKILL_PROFILE_PERSISTENCE_FAILED' });
    await app.close();
  });
});
