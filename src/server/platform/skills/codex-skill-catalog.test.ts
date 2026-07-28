/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { CodexSkillCatalog } from './codex-skill-catalog.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';

function fake(result: unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let closed = 0;
  return {
    calls, closed: () => closed,
    launch: () => ({ close: () => { closed += 1; }, rpc: { request: async (method: string, params: unknown) => { calls.push({ method, params }); return method === 'skills/list' ? result : {}; } } }),
  };
}

describe('CodexSkillCatalog', () => {
  it('initializes, requests a fresh single-workspace catalog, maps metadata, and closes', async () => {
    const server = fake({ data: [{ cwd: '/workspace', errors: [], skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A', shortDescription: 'short', interface: { displayName: 'Alpha CLI', shortDescription: 'interface', iconSmall: '/small.svg', iconLarge: '/large.svg', brandColor: '#fff', defaultPrompt: 'go' }, dependencies: { tools: [{ type: 'stdio', value: 'git', description: 'Git', transport: 'stdio', command: 'git', url: 'https://example.test/git' }] }, scope: 'project' }] }] });
    const catalog = new CodexSkillCatalog('work', server.launch, 20);
    await expect(catalog.list('/workspace')).resolves.toEqual({ skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A', shortDescription: 'short', interface: { displayName: 'Alpha CLI', shortDescription: 'interface', iconSmall: '/small.svg', iconLarge: '/large.svg', brandColor: '#fff', defaultPrompt: 'go' }, dependencies: { tools: [{ type: 'stdio', value: 'git', description: 'Git', transport: 'stdio', command: 'git', url: 'https://example.test/git' }] }, scope: 'project' }], errors: [] });
    expect(server.calls).toEqual([
      {
        method: 'initialize',
        params: { clientInfo: { name: 'gestalt-mobile', version: '0.1.0' }, capabilities: null },
      },
      { method: 'skills/list', params: { cwds: ['/workspace'], forceReload: true } },
    ]);
    expect(server.closed()).toBe(1);
  });

  it.each([
    { label: 'malformed', result: { data: [{ cwd: '/workspace', errors: [], skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: 'yes', description: 'A' }] }] } },
    { label: 'wrong workspace', result: { data: [{ cwd: '/other', errors: [], skills: [] }] } },
    { label: 'missing workspace', result: { data: [] } },
  ])('rejects $label discovery responses and still closes', async ({ result }) => {
    const server = fake(result);
    await expect(new CodexSkillCatalog('work', server.launch, 20).list('/workspace')).rejects.toBeInstanceOf(SkillProfileError);
    expect(server.closed()).toBe(1);
  });

  it('returns valid skills with stable discovery errors', async () => {
    const server = fake({ data: [{ cwd: '/workspace', errors: [{ message: 'bad manifest' }], skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A' }] }] });
    await expect(new CodexSkillCatalog('work', server.launch, 20).list('/workspace')).resolves.toEqual({
      skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A' }],
      errors: [{ message: 'bad manifest' }],
    });
  });

  it('normalizes null optional metadata returned by current Codex versions', async () => {
    const server = fake({ data: [{ cwd: '/workspace', errors: [], skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A', interface: { displayName: 'Alpha CLI', shortDescription: null, iconSmall: null, iconLarge: null, brandColor: null, defaultPrompt: null } }] }] });
    await expect(new CodexSkillCatalog('work', server.launch, 20).list('/workspace')).resolves.toEqual({
      skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A', interface: { displayName: 'Alpha CLI' } }],
      errors: [],
    });
  });

  it('rejects malformed tool dependencies', async () => {
    const server = fake({ data: [{ cwd: '/workspace', errors: [], skills: [{ name: 'Alpha', path: '/skills/a/SKILL.md', enabled: true, description: 'A', dependencies: { tools: [{ type: 'stdio' }] } }] }] });
    await expect(new CodexSkillCatalog('work', server.launch, 20).list('/workspace')).rejects.toBeInstanceOf(SkillProfileError);
  });
});
