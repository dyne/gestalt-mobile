import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerPromoteRecentThread } from './endpoint.js';

describe('POST /api/sessions/recent-threads/open', () => {
  it('promotes only a thread returned by the recent Codex thread list', async () => {
    const app = fastify();
    const promote = vi.fn(async (thread) => ({ id: 'session-1', threadId: thread.id }));
    registerPromoteRecentThread(app, {
      list: async () => [{ id: 'thread-1', cwd: '/work/project', recencyAt: 100 }],
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
      recencyAt: 100,
    });
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
});
