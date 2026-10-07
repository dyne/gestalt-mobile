/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { CachedSkillCatalog } from './cached-skill-catalog.js';

describe('CachedSkillCatalog', () => {
  it('invalidates retrieval availability without another discovery and isolates managed homes', async () => {
    const result = {
      skills: [{ name: 'gestalt:xerj', path: '/xerj/SKILL.md', enabled: true }],
      errors: [],
    };
    const discover = vi.fn(async () => result);
    let available = true;
    const catalog = new CachedSkillCatalog(
      discover,
      async (_provider, _profile, _workspace, current) => ({
        ...current,
        skills: current.skills.map((skill) => ({ ...skill, enabled: available && skill.enabled })),
      }),
    );
    await catalog.refresh('codex', 'default', '/workspace');
    available = false;
    expect((await catalog.list('codex', 'default', '/workspace')).skills[0].enabled).toBe(false);
    expect(discover).toHaveBeenCalledOnce();
    expect(
      (await new CachedSkillCatalog(discover).list('codex', 'default', '/workspace')).skills,
    ).toEqual([]);
    expect((await catalog.list('kimi', 'default', '/workspace')).skills).toEqual([]);
  });
  it('serves a startup refresh from memory until an explicit refresh', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({
        skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true }],
        errors: [],
      })
      .mockResolvedValueOnce({
        skills: [{ name: 'Beta', path: '/skills/b/SKILL.md', enabled: false }],
        errors: [],
      });
    const catalog = new CachedSkillCatalog(discover);

    await catalog.refresh('codex', 'default', '/workspace');
    await expect(catalog.list('codex', 'default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Alpha' }],
    });
    expect(discover).toHaveBeenCalledTimes(1);

    await catalog.refresh('codex', 'default', '/workspace');
    await expect(catalog.list('codex', 'default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Beta' }],
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('caches each provider independently for the same workspace and profile', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ skills: [{ name: 'Codex', path: '/c', enabled: true }], errors: [] })
      .mockResolvedValueOnce({ skills: [{ name: 'Kimi', path: '/k', enabled: true }], errors: [] });
    const catalog = new CachedSkillCatalog(discover);
    await catalog.refresh('codex', 'default', '/workspace');
    await catalog.refresh('kimi', 'default', '/workspace');
    await expect(catalog.list('codex', 'default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Codex' }],
    });
    await expect(catalog.list('kimi', 'default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Kimi' }],
    });
  });

  it('asks for an explicit refresh when a workspace/profile pair was not primed', async () => {
    const catalog = new CachedSkillCatalog(vi.fn());
    await expect(catalog.list('codex', 'other', '/workspace')).resolves.toEqual({
      skills: [],
      errors: [
        {
          message:
            'Skills are not cached for this workspace and profile. Select Refresh skills to discover them.',
        },
      ],
    });
  });
});
