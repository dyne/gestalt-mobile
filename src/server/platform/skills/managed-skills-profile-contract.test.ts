/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compileSkillOverride,
  createSkillProfile,
  parseSkillProfileYaml,
  serializeSkillProfileYaml,
  type SkillProfile,
} from '../../features/skills/model/skill-profile.js';
import { startSession } from '../../features/sessions/start-session/use-case.js';
import { threadSkillConfig } from '../codex/session-runtime.js';
import { KimiSkillCatalog } from '../kimi/kimi-skill-catalog.js';
import type { KimiWebServerManager } from '../kimi/kimi-web-server-manager.js';
import { materializeKimiSkillsDir } from '../kimi/kimi-skills-materializer.js';
import { ManagedSkillCatalog } from './managed-skill-catalog.js';
import { FilesystemSkillProfileStore } from './filesystem-skill-profile-store.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'managed-skill-profiles-'));
  roots.push(root);
  const codexHome = join(root, 'custom codex');
  const managed = join(codexHome, 'gestalt-skills/skills/nuklear-gui/SKILL.md');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(join(dirname(managed), 'references'), { recursive: true });
  await writeFile(managed, '---\nname: nuklear-gui\ndescription: Native GUI guidance\n---\n');
  await writeFile(join(dirname(managed), 'references/guide.md'), 'version one');
  const catalog = new ManagedSkillCatalog(codexHome);
  const store = new FilesystemSkillProfileStore(root);
  return { root, codexHome, managed, workspace, catalog, store };
}

describe('managed optional skill provider/profile contract', () => {
  it('discovers ordinary managed content independently of absent or damaged receipts and ignores metadata claims', async () => {
    const f = await fixture();
    const expected = {
      name: 'nuklear-gui',
      path: f.managed,
      description: 'Native GUI guidance',
      enabled: true,
      scope: 'user',
    };
    expect((await f.catalog.list()).skills).toEqual([expected]);
    await writeFile(join(f.codexHome, 'gestalt-skills/receipt.json'), 'damaged');
    await writeFile(
      f.managed,
      '---\nname: nuklear-gui\ndescription: Native GUI guidance\nprovenance: {kind: gestalt-verified}\n---\n',
    );
    expect((await f.catalog.list()).skills).toEqual([expected]);
    expect(await new ManagedSkillCatalog(join(f.root, 'missing')).list()).toEqual({
      skills: [],
      errors: [],
    });
  });

  it('adds managed skills to Kimi discovery with canonical identity, without duplicate directory entries or process bypass configuration', async () => {
    const f = await fixture();
    const user = join(f.root, 'user/nuklear-gui');
    await mkdir(user, { recursive: true });
    await writeFile(join(user, 'SKILL.md'), '---\nname: nuklear-gui\n---\n');
    const requests: unknown[][] = [];
    const servers = {
      ensure: async (...args: unknown[]) => {
        requests.push(args);
        return {
          client: {
            get: async (path: string) =>
              path === '/api/v1/workspaces'
                ? { items: [{ id: 'w', root: f.workspace }] }
                : {
                    skills: [
                      { name: 'nuklear-gui', path: dirname(f.managed) },
                      { name: 'nuklear-gui', path: user },
                    ],
                  },
          },
        };
      },
    } as unknown as KimiWebServerManager;
    const catalog = new KimiSkillCatalog(servers, true, f.catalog);
    const discovered = await catalog.list(f.workspace);
    expect(discovered.skills.map(({ path }) => path)).toEqual([user, f.managed]);
    expect(requests).toEqual([['default', []]]);
    expect((await new KimiSkillCatalog(null, false, f.catalog).list(f.workspace)).skills).toEqual(
      [],
    );
    const noWorkspace = {
      ensure: async () => ({ client: { get: async () => ({ items: [] }) } }),
    } as unknown as KimiWebServerManager;
    expect(
      (await new KimiSkillCatalog(noWorkspace, true, f.catalog).list(f.workspace)).skills.map(
        (skill) => skill.path,
      ),
    ).toEqual([f.managed]);
  });

  it.each(['codex', 'kimi'] as const)(
    'keeps %s native defaults, complete snapshots and explicit precedence independent of provenance',
    async (provider) => {
      const f = await fixture();
      let project: SkillProfile | undefined;
      let explicit: SkillProfile | undefined;
      const profile = (enabled: boolean) =>
        createSkillProfile({
          name: 'work',
          skills: [{ name: 'nuklear-gui', path: f.managed, enabled }],
        });
      const start = async () =>
        startSession(
          {
            workspaceId: 'w',
            profile: 'default',
            provider,
            ...(explicit ? { skillProfile: 'work' } : {}),
          },
          {
            createId: () => 's',
            now: () => '2026-10-31T00:00:00Z',
            save: () => {},
            workspaces: {
              resolve: async () => ({ id: 'w', name: 'workspace', realPath: f.workspace }),
            },
            profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
            skillProfiles: {
              readGlobalProfile: async () => explicit,
              readWorkspaceDefault: async () => project,
            },
            skillCatalog: () => f.catalog,
          },
        );
      expect((await start()).effectiveSkillSelection?.skills).toEqual([
        { name: 'nuklear-gui', path: f.managed, enabled: true },
      ]);
      project = profile(false);
      expect((await start()).effectiveSkillSelection?.skills[0].enabled).toBe(false);
      explicit = profile(true);
      expect((await start()).effectiveSkillSelection).toMatchObject({
        selectedProfileName: 'work',
        skills: [{ enabled: true }],
      });
      project = profile(true);
      explicit = profile(false);
      expect((await start()).effectiveSkillSelection?.skills[0].enabled).toBe(false);
      explicit = createSkillProfile({ name: 'old-complete-snapshot', skills: [] });
      expect((await start()).effectiveSkillSelection?.skills[0].enabled).toBe(false);
    },
  );

  it.each([true, false])(
    'retains saved %s through global/project YAML, export/import, update and provider configuration',
    async (enabled) => {
      const f = await fixture();
      const profile = createSkillProfile({
        name: 'work',
        skills: [{ name: 'nuklear-gui', path: f.managed, enabled }],
      });
      await f.store.replaceGlobalProfile(profile);
      const yaml = serializeSkillProfileYaml((await f.store.readGlobalProfile('work'))!);
      const imported = parseSkillProfileYaml(yaml);
      await writeFile(join(f.workspace, 'gestalt-skills.yml'), yaml);
      expect((await f.store.readWorkspaceDefault(f.workspace))?.skills).toEqual(imported.skills);
      await writeFile(join(dirname(f.managed), 'references/guide.md'), 'version two');
      const added = join(f.codexHome, 'gestalt-skills/skills/new-skill/SKILL.md');
      await mkdir(dirname(added), { recursive: true });
      await writeFile(added, '---\nname: new-skill\ndescription: Added after saving\n---\n');
      const discovered = await f.catalog.list();
      const compiled = compileSkillOverride({
        discovered: discovered.skills,
        explicit: imported.skills,
      });
      expect(compiled.skillsConfig).toContainEqual({ path: f.managed, enabled });
      expect(compiled.skillsConfig).toContainEqual({ path: added, enabled: false });
      expect(threadSkillConfig(compiled.skillsConfig)).toEqual({
        config: { 'tools.update_plan.enabled': true, skills: { config: compiled.skillsConfig } },
      });
      const skillsDir = join(f.root, 'isolated-kimi/skills');
      const result = materializeKimiSkillsDir(
        skillsDir,
        compiled.skillsConfig.map((entry) => ({ ...entry, name: 'display metadata' })),
      );
      expect(result.linked).toEqual(enabled ? [f.managed] : []);
      if (enabled)
        expect(await readFile(join(skillsDir, 'nuklear-gui/references/guide.md'), 'utf8')).toBe(
          'version two',
        );
      expect((await f.store.readGlobalProfile('work'))?.skills).toEqual(profile.skills);
      await rm(dirname(f.managed), { recursive: true });
      const missing = compileSkillOverride({
        discovered: (await f.catalog.list()).skills,
        explicit: imported.skills,
      });
      expect(missing.skillsConfig).toEqual([{ path: added, enabled: false }]);
      expect(missing.warnings[0]).toContain(f.managed);
      expect(() =>
        parseSkillProfileYaml(
          yaml.replace('    enabled:', '    provenance: {kind: gestalt-verified}\n    enabled:'),
        ),
      ).toThrow();
    },
  );
});
