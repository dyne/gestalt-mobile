import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerReleaseSession } from './endpoint.js';

describe('POST /api/sessions/:id/release', () => {
  it('persists release before closing relay ownership', async () => {
    const app = fastify();
    const calls: string[] = [];
    registerReleaseSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      release: () => ({ id: 'session-1', state: 'released' }) as never,
      save: () => calls.push('save'),
      close: () => calls.push('close'),
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/session-1/release' })).statusCode,
    ).toBe(202);
    expect(calls).toEqual(['save', 'close']);
    await app.close();
  });
});
