import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStartSession } from './endpoint.js';
describe('POST /api/sessions', () => {
  it('accepts a new session', async () => {
    const app = fastify();
    registerStartSession(app, { createId: () => 's', now: () => 't', save: () => {} });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', workspacePath: '/w', profile: 'default' },
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });
});
