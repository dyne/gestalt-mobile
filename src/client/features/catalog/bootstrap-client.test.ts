/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  flattenWorkspaceTree,
  loadBootstrap,
  type Bootstrap,
} from './bootstrap-client.js';
describe('loadBootstrap', () => {
  it('returns the recursive workspace tree from the API payload', async () => {
    const payload = {
      workspaces: [
        {
          id: 'root',
          name: '/',
          relativePath: '.',
          isGitRepository: false,
          children: [
            {
              id: 'group',
              name: 'group',
              relativePath: 'group',
              isGitRepository: false,
              children: [
                {
                  id: 'repository',
                  name: 'repository',
                  relativePath: 'group/repository',
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
      capabilities: {
        approvals: true,
        userInput: true,
        git: true,
        protocolCompatible: true,
      },
    } satisfies Bootstrap;

    await expect(
      loadBootstrap(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as Response,
      ),
    ).resolves.toEqual(payload);
    expect(flattenWorkspaceTree(payload.workspaces).map((workspace) => workspace.id)).toEqual([
      'root',
      'group',
      'repository',
    ]);
  });
});
