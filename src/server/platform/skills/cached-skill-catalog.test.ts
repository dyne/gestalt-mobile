/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { CachedSkillCatalog } from './cached-skill-catalog.js';

describe('CachedSkillCatalog', () => {
  it('serves a startup refresh from memory until an explicit refresh', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true }], errors: [] })
      .mockResolvedValueOnce({ skills: [{ name: 'Beta', path: '/skills/b/SKILL.md', enabled: false }], errors: [] });
    const catalog = new CachedSkillCatalog(discover);

    await catalog.refresh('default', '/workspace');
    await expect(catalog.list('default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Alpha' }],
    });
    expect(discover).toHaveBeenCalledTimes(1);

    await catalog.refresh('default', '/workspace');
    await expect(catalog.list('default', '/workspace')).resolves.toMatchObject({
      skills: [{ name: 'Beta' }],
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('asks for an explicit refresh when a workspace/profile pair was not primed', async () => {
    const catalog = new CachedSkillCatalog(vi.fn());
    await expect(catalog.list('other', '/workspace')).resolves.toEqual({
      skills: [],
      errors: [
        {
          message:
            'Skills are not cached for this workspace and Codex profile. Select Refresh skills to discover them.',
        },
      ],
    });
  });
});
