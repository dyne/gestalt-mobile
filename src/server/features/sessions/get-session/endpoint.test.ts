import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerGetSession } from './endpoint.js';
describe('GET /api/sessions/:id', () => {
  it('returns a stable not-found result', async () => {
    const app = fastify();
    registerGetSession(app, () => null);
    expect((await app.inject('/api/sessions/nope')).statusCode).toBe(404);
    await app.close();
  });
});
