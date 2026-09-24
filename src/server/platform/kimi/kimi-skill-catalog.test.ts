/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { KimiSkillCatalog } from './kimi-skill-catalog.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

function catalogWith(getRoutes: Map<string, unknown> | (() => Error)): KimiSkillCatalog {
  const client = {
    get: async (path: string) => {
      if (typeof getRoutes === 'function') throw getRoutes();
      const route = getRoutes.get(path);
      if (route === undefined) throw new Error(`no route ${path}`);
      return route;
    },
  };
  const servers = {
    ensure: async () => ({ client }),
  } as unknown as KimiWebServerManager;
  return new KimiSkillCatalog(servers, true);
}

describe('KimiSkillCatalog', () => {
  it('returns nothing when kimi is unavailable', async () => {
    const catalog = new KimiSkillCatalog(null, false);
    expect(await catalog.list('/repo')).toEqual({ skills: [], errors: [] });
  });

  it('maps workspace skills onto the neutral catalog contract', async () => {
    const catalog = catalogWith(
      new Map([
        [
          '/api/v1/workspaces',
          {
            items: [{ id: 'wd_abc', root: '/repo', name: 'repo' }],
          },
        ],
        [
          '/api/v1/workspaces/wd_abc/skills',
          {
            skills: [
              {
                name: 'reviewer',
                description: 'Reviews code',
                path: '/repo/.kimi/skills/reviewer',
                source: 'project',
              },
              { name: 'builtin-planner', source: 'builtin' },
              { name: '' },
            ],
          },
        ],
      ]),
    );
    const result = await catalog.list('/repo');
    expect(result.skills).toEqual([
      {
        name: 'reviewer',
        path: '/repo/.kimi/skills/reviewer',
        enabled: true,
        description: 'Reviews code',
        scope: 'kimi:project',
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('omits kimi built-ins that report no materializable filesystem path', async () => {
    const catalog = catalogWith(
      new Map([
        ['/api/v1/workspaces', { items: [{ id: 'wd_abc', root: '/repo', name: 'repo' }] }],
        [
          '/api/v1/workspaces/wd_abc/skills',
          { skills: [{ name: 'builtin-planner', source: 'builtin' }] },
        ],
      ]),
    );
    const result = await catalog.list('/repo');
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports when kimi has no workspace registered for the path', async () => {
    const catalog = catalogWith(new Map([['/api/v1/workspaces', { items: [] }]]));
    const result = await catalog.list('/repo');
    expect(result.skills).toEqual([]);
    expect(result.errors[0]?.message).toContain('no registered workspace');
  });

  it('degrades to a discovery error when the server call fails', async () => {
    const catalog = catalogWith(() => new Error('down'));
    const result = await catalog.list('/repo');
    expect(result.skills).toEqual([]);
    expect(result.errors[0]?.message).toBe('Kimi skill discovery failed.');
  });
});
