/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { buildApp } from '../../src/server/app.js';
import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../src/server/features/sessions/model/relay-session.js';
import { installedSkillsFixture } from './installed-skills-fixture.js';

const fixture = await installedSkillsFixture();
const port = Number(process.env.VERIFIED_SKILLS_PORT ?? 4187);
const sessions = new Map<string, RelaySessionSnapshot>();
const workspaces = {
  list: async () => [
    {
      id: 'workspace',
      name: 'unrelated workspace',
      relativePath: '.',
      isGitRepository: false,
      children: [],
    },
  ],
  resolve: async (id: string) => {
    if (id !== 'workspace') throw new Error('WORKSPACE_NOT_FOUND');
    return { id, name: 'unrelated workspace', realPath: fixture.workspace };
  },
};
const profiles = {
  list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
  require: async (name: string) => {
    if (name !== 'default') throw new Error('PROFILE_NOT_FOUND');
    return { name, state: 'ok' as const, status: 'ready' };
  },
};
// Match the client session default; model inference itself is outside this fixture.
const models = { list: async (provider: string) => (provider === 'codex' ? ['gpt-6.1-sol'] : []) };
const app = await buildApp({
  health: {
    read: async () => ({
      status: 'ok',
      version: 'qualification',
      codex: { installedVersion: null, protocolVersion: 'qualification', compatible: true },
      providers: { codex: { available: true }, kimi: { available: false } },
    }),
  },
  logger: console,
  passkeyAuthDisabled: true,
  staticDir: resolve(import.meta.dirname, '../../dist/client'),
  bootstrap: {
    workspaces,
    profiles,
    models,
    sessions: { list: () => [...sessions.values()] },
    protocolCompatible: true,
    providers: { codex: { available: true }, kimi: { available: false } },
  },
  recentThreads: { list: async () => [] },
  skills: {
    workspaces,
    profiles,
    catalog: fixture.catalog,
    selections: fixture.profiles,
    listGlobalProfileNames: () => fixture.profiles.listGlobalProfileNames(),
    readGlobalProfile: (name) => fixture.profiles.readGlobalProfile(name),
    replaceGlobalProfile: async (profile) => {
      await fixture.profiles.replaceGlobalProfile(profile);
      await fixture.record();
    },
    deleteGlobalProfile: (name) => fixture.profiles.deleteGlobalProfile(name),
    profilePath: (name) => fixture.profiles.globalProfilePath(name),
  },
  sessionRoutes: {
    createId: randomUUID,
    now: () => new Date().toISOString(),
    save: (session) => {
      sessions.set(session.id, session);
    },
    find: (id) => sessions.get(id) ?? null,
    list: () => [...sessions.values()],
    workspaces,
    profiles,
    models,
    sessionModels: models,
    skillProfiles: fixture.profiles,
    skillCatalog: () => ({ list: (cwd) => fixture.catalog.refresh('codex', 'default', cwd) }),
    activate: async (session) => {
      const result = await fixture.nativeSession(
        session.id,
        session.effectiveSkillSelection!.skills,
      );
      const now = new Date().toISOString();
      // The native thread was actually started, inspected and archived. Expose
      // its truthful stopped state; this fixture never offers a model turn.
      return RelaySession.rehydrate(session)
        .bindThread(result.threadStartAccepted.id, now)
        .stop(now).snapshot;
    },
    readHistory: async () => ({ turns: [], activeTurnId: null }),
  },
  sessionEvents: {
    exists: (id) => sessions.has(id),
    replay: () => ({ kind: 'replay', events: [] }),
    subscribe: () => () => {},
  },
});

// Test-only control surface, bound to a disposable loopback server. Real API
// routes above use production services and are never intercepted by the browser.
app.get('/__fixture/evidence', () => fixture.record());
app.post('/__fixture/settle', async () => {
  await fixture.close();
  return fixture.record();
});
app.post<{ Params: { operation: string } }>('/__fixture/maintenance/:operation', (request) =>
  fixture.maintain(request.params.operation),
);
await app.listen({ host: '127.0.0.1', port });
process.stderr.write('VERIFIED_SKILLS_READY\n');
const close = async () => {
  await app.close();
  await fixture.close();
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
