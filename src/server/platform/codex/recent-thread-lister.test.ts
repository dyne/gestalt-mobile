import { describe, expect, it } from 'vitest';

import { createRecentThreadLister } from './recent-thread-lister.js';

describe('recent Codex thread lister', () => {
  it('lists ready profiles, merges duplicate threads, and orders them by recency', async () => {
    const calls: Array<{ profile: string; cwd: string; method: string; params: unknown }> = [];
    const closeCalls: string[] = [];
    const lister = createRecentThreadLister({
      root: '/relay-root',
      profiles: {
        list: async () => [
          { name: 'default', state: 'ok', status: 'ready' },
          { name: 'offline', state: 'not_logged_in', status: 'sign in' },
          { name: 'work', state: 'ok', status: 'ready' },
        ],
      },
      launch: ({ profile, cwd }) => ({
        rpc: {
          request: async (method, params) => {
            calls.push({ profile, cwd, method, params });
            if (method === 'initialize') return {};
            return {
              data:
                profile === 'default'
                  ? [
                      { id: 'same', cwd: '/projects/shared', recencyAt: 10 },
                      { id: 'old', cwd: '/projects/old', recencyAt: 5 },
                    ]
                  : [
                      { id: 'new', cwd: '/projects/new', recencyAt: 20 },
                      { id: 'same', cwd: '/projects/shared', recencyAt: 10 },
                    ],
              nextCursor: null,
            };
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => closeCalls.push(profile),
      }),
    });

    await expect(lister.list()).resolves.toEqual([
      { id: 'new', cwd: '/projects/new', recencyAt: 20 },
      { id: 'same', cwd: '/projects/shared', recencyAt: 10 },
      { id: 'old', cwd: '/projects/old', recencyAt: 5 },
    ]);
    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'thread/list')).toEqual([
      expect.objectContaining({
        profile: expect.any(String),
        cwd: '/relay-root',
        params: {
          limit: 20,
          sortKey: 'recency_at',
          sortDirection: 'desc',
          sourceKinds: ['cli', 'appServer'],
        },
      }),
      expect.objectContaining({ profile: expect.any(String), cwd: '/relay-root' }),
    ]);
    expect(closeCalls.sort()).toEqual(['default', 'work']);
  });
});
