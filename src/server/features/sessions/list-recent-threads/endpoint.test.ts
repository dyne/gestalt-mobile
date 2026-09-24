/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, type AppDependencies } from '../../../app.js';
import { registerListRecentThreads } from './endpoint.js';

describe('GET /api/sessions/recent-threads', () => {
  it('returns recent Codex sessions, including sessions not managed by the relay', async () => {
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
          providers: { codex: { available: true }, kimi: { available: false as const } },
        }),
      },
      logger: console,
      recentThreads: {
        list: async () => [
          { id: 'thread-new', cwd: '/projects/new', profile: 'work', recencyAt: 200 },
          { id: 'thread-old', cwd: '/projects/old', profile: 'default', recencyAt: 100 },
        ],
      },
    } as AppDependencies);

    const response = await app.inject({ method: 'GET', url: '/api/sessions/recent-threads' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: 'thread-new',
        cwd: '/projects/new',
        recencyAt: 200,
        resumeCommand:
          "'codex' 'resume' 'thread-new' '-C' '/projects/new' '--include-non-interactive'",
      },
      {
        id: 'thread-old',
        cwd: '/projects/old',
        recencyAt: 100,
        resumeCommand:
          "'codex' 'resume' 'thread-old' '-C' '/projects/old' '--include-non-interactive'",
      },
    ]);
    await app.close();
  });

  it('adds managed-session metadata when it is available', async () => {
    const app = fastify();
    registerListRecentThreads(app, {
      list: async () => [
        { id: 'thread-1', cwd: '/projects/work', profile: 'work', recencyAt: 200 },
      ],
      metadata: () => ({
        model: 'gpt-5.4',
        skillProfile: 'focused',
        orgPlanFilename: 'session-summary.org',
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/sessions/recent-threads' });

    expect(response.json()).toMatchObject([
      {
        id: 'thread-1',
        model: 'gpt-5.4',
        skillProfile: 'focused',
        orgPlanFilename: 'session-summary.org',
      },
    ]);
    await app.close();
  });

  it('looks up managed-session metadata with provider-qualified thread identity', async () => {
    const app = fastify();
    const lookups: Array<[string, string]> = [];
    registerListRecentThreads(app, {
      list: async () => [
        { id: 'shared-thread', cwd: '/codex', profile: 'default', recencyAt: 2 },
        {
          id: 'shared-thread',
          cwd: '/kimi',
          profile: 'default',
          provider: 'kimi',
          recencyAt: 1,
        },
      ],
      metadata: (threadId, provider) => {
        lookups.push([threadId, provider]);
        return provider === 'kimi' ? { model: 'k2-thinking' } : { model: 'gpt-5.6-terra' };
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/sessions/recent-threads' });

    expect(lookups).toEqual([
      ['shared-thread', 'codex'],
      ['shared-thread', 'kimi'],
    ]);
    expect(response.json()).toMatchObject([
      { id: 'shared-thread', model: 'gpt-5.6-terra' },
      { id: 'shared-thread', provider: 'kimi', model: 'k2-thinking' },
    ]);
    await app.close();
  });
});
