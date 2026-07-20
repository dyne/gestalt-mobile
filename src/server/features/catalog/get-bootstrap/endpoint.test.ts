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
      protocolCompatible: true,
    });
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
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
      capabilities: { approvals: true, userInput: true, git: true, protocolCompatible: true },
    });
    await app.close();
  });
});
