import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRestoreSession } from './endpoint.js';

describe('POST /api/sessions/:id/restore', () => {
  it('restores a resumable session and persists its ready state', async () => {
    const app = fastify();
    let saved = false;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'stopped' }) as never,
      restore: async () => ({ id: 'session-1', state: 'ready' }) as never,
      save: () => {
        saved = true;
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(200);
    expect(saved).toBe(true);
    await app.close();
  });
});
