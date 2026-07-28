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

const bootstrap = {
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

describe('loadBootstrap', () => {
  it('returns the recursive workspace tree from the API payload', async () => {
    await expect(
      loadBootstrap(
        async () =>
          new Response(JSON.stringify(bootstrap), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as Response,
      ),
    ).resolves.toEqual(bootstrap);
    expect(flattenWorkspaceTree(bootstrap.workspaces).map((workspace) => workspace.id)).toEqual([
      'root',
      'group',
      'repository',
    ]);
  });

  it('retries a transient unavailable response while the relay starts', async () => {
    let attempts = 0;
    await expect(
      loadBootstrap(async () => {
        attempts += 1;
        if (attempts === 1) return new Response(null, { status: 503 }) as Response;
        return new Response(JSON.stringify(bootstrap), { status: 200 }) as Response;
      }),
    ).resolves.toEqual(bootstrap);
    expect(attempts).toBe(2);
  });

  it('retries a transient connection failure while the relay starts', async () => {
    let attempts = 0;
    await expect(
      loadBootstrap(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Network unavailable');
        return new Response(JSON.stringify(bootstrap), { status: 200 }) as Response;
      }),
    ).resolves.toEqual(bootstrap);
    expect(attempts).toBe(2);
  });

  it('does not retry a persistent non-startup failure', async () => {
    let attempts = 0;
    await expect(
      loadBootstrap(async () => {
        attempts += 1;
        return new Response(null, { status: 500 }) as Response;
      }),
    ).rejects.toThrow('BOOTSTRAP_FAILED');
    expect(attempts).toBe(1);
  });
});
