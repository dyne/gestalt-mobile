import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerGetBootstrap } from './endpoint.js';

describe('GET /api/bootstrap', () => {
  it('returns public catalogs and relay capabilities', async () => {
    const app = fastify();
    registerGetBootstrap(app, {
      workspaces: { list: async () => [{ id: 'w', name: 'Work', isGitRepository: true }] },
      profiles: { list: async () => [{ name: 'default', state: 'ok', status: 'ready' }] },
      sessions: { list: () => [] },
      protocolCompatible: true,
    });
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaces: [{ id: 'w', name: 'Work', isGitRepository: true }],
      profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
      sessions: [],
      capabilities: { approvals: true, userInput: true, git: true, protocolCompatible: true },
    });
    await app.close();
  });
});
