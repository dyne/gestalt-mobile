/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerPromoteRecentThread } from './endpoint.js';
import { RecentThreadHistoryUnavailable } from './use-case.js';

describe('POST /api/sessions/recent-threads/open', () => {
  it('promotes only a thread returned by the recent Codex thread list', async () => {
    const app = fastify();
    const promote = vi.fn(async (thread) => ({ id: 'session-1', threadId: thread.id }));
    registerPromoteRecentThread(app, {
      list: async () => [{ id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 }],
      promote: promote as never,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'thread-1', cwd: '/work/project' },
    });

    expect(response.statusCode).toBe(202);
    expect(promote).toHaveBeenCalledWith({
      id: 'thread-1',
      cwd: '/work/project',
      profile: 'work',
      recencyAt: 100,
    });
    await app.close();
  });

  it('selects a same-id recent thread by provider and defaults legacy requests to Codex', async () => {
    const app = fastify();
    const codex = { id: 'shared-thread', cwd: '/work/project', profile: 'work', recencyAt: 100 };
    const kimi = { ...codex, provider: 'kimi' as const };
    const promote = vi.fn(async (thread) => ({ id: 'session-1', provider: thread.provider }));
    registerPromoteRecentThread(app, {
      list: async () => [codex, kimi],
      promote: promote as never,
    });

    const kimiResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'shared-thread', cwd: '/work/project', provider: 'kimi' },
    });
    const legacyResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'shared-thread', cwd: '/work/project' },
    });

    expect(kimiResponse.statusCode).toBe(202);
    expect(legacyResponse.statusCode).toBe(202);
    expect(promote).toHaveBeenNthCalledWith(1, kimi);
    expect(promote).toHaveBeenNthCalledWith(2, codex);
    await app.close();
  });

  it('rejects a thread and path pair outside the recent list', async () => {
    const app = fastify();
    const promote = vi.fn();
    registerPromoteRecentThread(app, { list: async () => [], promote });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'thread-1', cwd: '/other/project' },
    });

    expect(response.statusCode).toBe(404);
    expect(promote).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a stable safe history-unavailable code', async () => {
    const app = fastify();
    registerPromoteRecentThread(app, {
      list: async () => [{ id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 1 }],
      promote: async () => {
        throw new RecentThreadHistoryUnavailable();
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'thread-1', cwd: '/work/project' },
    });
    expect(response.json()).toMatchObject({ code: 'RECENT_THREAD_HISTORY_UNAVAILABLE' });
    await app.close();
  });

  it('uses a generic detail when persistence or another open operation fails', async () => {
    const app = fastify();
    registerPromoteRecentThread(app, {
      list: async () => [{ id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 1 }],
      promote: async () => {
        throw new Error('sqlite write failed');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/recent-threads/open',
      payload: { threadId: 'thread-1', cwd: '/work/project' },
    });
    expect(response.json()).toEqual({
      code: 'RECENT_THREAD_OPEN_FAILED',
      detail: 'The selected thread could not be opened. Retry shortly.',
    });
    await app.close();
  });
});
