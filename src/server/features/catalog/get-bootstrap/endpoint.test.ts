/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerGetBootstrap } from './endpoint.js';

describe('GET /api/bootstrap', () => {
  it('returns public catalogs and relay capabilities', async () => {
    const app = fastify();
    registerGetBootstrap(app, {
      workspaces: {
        list: async () => [
          {
            id: 'root',
            name: '/',
            relativePath: '.',
            isGitRepository: false,
            children: [
              {
                id: 'group',
                name: 'Group',
                relativePath: 'Group',
                isGitRepository: false,
                children: [
                  {
                    id: 'repo',
                    name: 'Repo',
                    relativePath: 'Group/Repo',
                    isGitRepository: true,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      profiles: { list: async () => [{ name: 'default', state: 'ok', status: 'ready' }] },
      sessions: { list: () => [] },
      versions: [
        { id: 'gestalt-mobile', label: 'Gestalt Mobile', version: '0.33.0' },
        { id: 'codex', label: 'Codex CLI', version: 'codex-cli 0.144.3' },
      ],
      protocolCompatible: true,
      providers: {
        codex: { available: true, version: 'codex-cli 0.144.3' },
        kimi: { available: false as const },
      },
    });
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: { codex: [], kimi: [] },
      workspaces: [
        {
          id: 'root',
          name: '/',
          relativePath: '.',
          isGitRepository: false,
          children: [
            {
              id: 'group',
              name: 'Group',
              relativePath: 'Group',
              isGitRepository: false,
              children: [
                {
                  id: 'repo',
                  name: 'Repo',
                  relativePath: 'Group/Repo',
                  isGitRepository: true,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
      sessions: [],
      versions: [
        { id: 'gestalt-mobile', label: 'Gestalt Mobile', version: '0.33.0' },
        { id: 'codex', label: 'Codex CLI', version: 'codex-cli 0.144.3' },
      ],
      capabilities: {
        approvals: true,
        userInput: true,
        git: true,
        protocolCompatible: true,
        providers: {
          codex: { available: true, version: 'codex-cli 0.144.3' },
          kimi: { available: false },
        },
      },
    });
    await app.close();
  });

  it('serves each provider model list from that provider catalog', async () => {
    const app = fastify();
    registerGetBootstrap(app, {
      workspaces: { list: async () => [] },
      profiles: { list: async () => [] },
      models: {
        list: async (provider) => (provider === 'codex' ? ['gpt-5.6-terra'] : []),
      },
      sessions: { list: () => [] },
      protocolCompatible: true,
      providers: {
        codex: { available: true, version: 'codex-cli 0.144.3' },
        kimi: { available: false as const },
      },
    });
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual({ codex: ['gpt-5.6-terra'], kimi: [] });
    await app.close();
  });
});
