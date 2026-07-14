import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStartSession } from './endpoint.js';
describe('POST /api/sessions', () => {
  it('accepts a new session', async () => {
    const app = fastify();
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default' },
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });
});
