/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSkillProfile,
  parseSkillProfileYaml,
  serializeSkillProfileYaml,
  type SkillProfile,
} from './model/skill-profile.js';
import { registerReplaceSkillProfile } from './replace-profile/endpoint.js';
import { registerListSkillProfiles } from './list-profiles/endpoint.js';
import { FilesystemSkillProfileStore } from '../../platform/skills/filesystem-skill-profile-store.js';
import { startSession } from '../sessions/start-session/use-case.js';
import { restore } from '../sessions/restore-session/use-case.js';
import { RelaySession } from '../sessions/model/relay-session.js';
import { openRelayDatabase } from '../../platform/persistence/sqlite.js';
import { migrate } from '../../platform/persistence/migrate.js';
import { SqliteSessionRepository } from '../../platform/persistence/sqlite-session-repository.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'playwright-profile-'));
  directories.push(path);
  return path;
}
const capabilities = (enabled: boolean) => ({ playwright: { enabled } });
const profile = (enabled: boolean) =>
  createSkillProfile({ name: 'browser', skills: [], capabilities: capabilities(enabled) });

describe('profile browser consent', () => {
  it.each([true, false])(
    'exports/imports explicit %s in version 2 while legacy stays version 1',
    (enabled) => {
      const saved = profile(enabled);
      expect(parseSkillProfileYaml(serializeSkillProfileYaml(saved))).toEqual(saved);
      const legacy = parseSkillProfileYaml('version: 1\nname: old\nskills: []\n');
      expect(legacy.capabilities?.playwright.enabled ?? false).toBe(false);
      expect(serializeSkillProfileYaml(legacy)).toContain('version: 1');
    },
  );

  it.each([
    'version: 3\nname: future\nskills: []',
    'version: 2\nname: missing\nskills: []',
    'version: 1\nname: old\nskills: []\ncapabilities: {playwright: {enabled: true}}',
    'version: 2\nname: wrong\nskills: []\ncapabilities: {playwright: {enabled: "true"}}',
    'version: 2\nname: extra\nskills: []\ncapabilities: {playwright: {enabled: true, command: shell}}',
    'version: 2\nname: extra\nskills: []\ncapabilities: {playwright: {enabled: true}, unknown: true}',
  ])('rejects unsupported or ambiguous YAML %s', (yaml) => {
    expect(() => parseSkillProfileYaml(yaml)).toThrow();
  });

  it('retains v2 through API replacement/listing and rejects unknown fields', async () => {
    const app = fastify();
    const profiles = new Map<string, SkillProfile>();
    const deps = {
      listGlobalProfileNames: async () => [...profiles.keys()],
      readGlobalProfile: async (name: string) => profiles.get(name),
      replaceGlobalProfile: async (value: SkillProfile) => {
        profiles.set(value.name, value);
      },
      profilePath: (name: string) => `/profiles/${name}.yml`,
    };
    registerReplaceSkillProfile(app, deps);
    registerListSkillProfiles(app, deps);
    try {
      for (const enabled of [true, false]) {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/skill-profiles/browser',
              payload: profile(enabled),
            })
          ).statusCode,
        ).toBe(enabled ? 201 : 200);
        expect((await app.inject('/api/skill-profiles')).json().profiles[0]).toMatchObject(
          profile(enabled),
        );
      }
      for (const payload of [
        { ...profile(true), version: 3 },
        { ...profile(true), capabilities: {} },
        { ...profile(true), capabilities: { playwright: { enabled: true, command: 'shell' } } },
        { ...profile(true), unknown: true },
      ])
        expect(
          (await app.inject({ method: 'PUT', url: '/api/skill-profiles/browser', payload }))
            .statusCode,
        ).toBe(400);
      expect(profiles.get('browser')).toEqual(profile(false));
    } finally {
      await app.close();
    }
  });

  it('persists, duplicates and deletes global choices and reads workspace YAML', async () => {
    const home = await directory();
    const workspace = await directory();
    const store = new FilesystemSkillProfileStore(home);
    await store.replaceGlobalProfile(profile(true));
    const original = (await store.readGlobalProfile('browser'))!;
    await store.replaceGlobalProfile({ ...original, name: 'copy' });
    await store.deleteGlobalProfile('browser');
    expect(await store.readGlobalProfile('browser')).toBeUndefined();
    expect(await store.readGlobalProfile('copy')).toEqual({ ...original, name: 'copy' });
    await writeFile(
      join(workspace, 'gestalt-skills.yml'),
      serializeSkillProfileYaml(profile(false)),
    );
    expect(await store.readWorkspaceDefault(workspace)).toEqual(profile(false));
  });

  it.each([
    { provider: 'codex' as const, global: undefined, workspace: undefined, enabled: false },
    { provider: 'codex' as const, global: undefined, workspace: profile(true), enabled: true },
    {
      provider: 'codex' as const,
      global: profile(false),
      workspace: profile(true),
      enabled: false,
    },
    {
      provider: 'codex' as const,
      global: createSkillProfile({ name: 'old', skills: [] }),
      workspace: profile(true),
      enabled: false,
    },
    { provider: 'codex' as const, global: profile(true), workspace: profile(false), enabled: true },
    { provider: 'kimi' as const, global: profile(true), workspace: profile(true), enabled: false },
  ])(
    'snapshots $provider global/workspace precedence with consent $enabled across persistence/resume',
    async ({ provider, global, workspace, enabled }) => {
      let workspaceProfile = workspace;
      const snapshot = await startSession(
        {
          workspaceId: 'w',
          profile: 'default',
          provider,
          ...(global ? { skillProfile: global.name } : {}),
        },
        {
          createId: () => 'session',
          now: () => '2026-10-28T00:00:00Z',
          save: () => {},
          workspaces: { resolve: async () => ({ id: 'w', name: 'work', realPath: '/workspace' }) },
          profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
          skillProfiles: {
            readGlobalProfile: async () => global,
            readWorkspaceDefault: async () => workspaceProfile,
          },
          skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
        },
      );
      expect(snapshot.effectiveSkillSelection?.capabilities?.playwright.enabled ?? false).toBe(
        enabled,
      );
      const path = join(await directory(), 'relay.sqlite');
      const db = openRelayDatabase(path);
      migrate(db);
      new SqliteSessionRepository(db).save(
        RelaySession.rehydrate(snapshot).bindThread('thread', 't').stop('t').snapshot,
      );
      db.close();
      workspaceProfile = profile(!enabled);
      const reopened = openRelayDatabase(path);
      try {
        const resumed = restore(new SqliteSessionRepository(reopened).find('session')!, 'later');
        expect(resumed.effectiveSkillSelection?.capabilities?.playwright.enabled ?? false).toBe(
          enabled,
        );
        expect(resumed.effectiveSkillSelection).toEqual(snapshot.effectiveSkillSelection);
      } finally {
        reopened.close();
      }
    },
  );

  it('forces Kimi off when a persisted or inherited snapshot requests browser access', () => {
    const session = RelaySession.create({
      id: 's',
      workspaceId: 'w',
      workspacePath: '/w',
      provider: 'kimi',
      profile: 'default',
      now: 't',
      effectiveSkillSelection: { skills: [], capabilities: capabilities(true) },
    }).snapshot;
    expect(session.effectiveSkillSelection?.capabilities).toEqual(capabilities(false));
    expect(
      RelaySession.rehydrate({
        ...session,
        effectiveSkillSelection: { skills: [], capabilities: capabilities(true) },
      }).snapshot.effectiveSkillSelection?.capabilities,
    ).toEqual(capabilities(false));
  });
});
