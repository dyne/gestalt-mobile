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

  it('replays a successful start for the same idempotency key', async () => {
    const app = fastify();
    const results = new Map<string, string>();
    let created = 0;
    registerStartSession(app, {
      createId: () => `s-${++created}`,
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      idempotency: {
        get: (_scope, key) =>
          results.has(key) ? { statusCode: 202, body: results.get(key)! } : null,
        put: (_scope, key, _statusCode, body) => results.set(key, body),
      },
    });
    const options = {
      method: 'POST' as const,
      url: '/api/sessions',
      headers: { 'idempotency-key': 'retry-1' },
      payload: { workspaceId: 'w', profile: 'default' },
    };
    const first = await app.inject(options);
    const second = await app.inject(options);
    expect([first.json().id, second.json().id]).toEqual(['s-1', 's-1']);
    expect(created).toBe(1);
    await app.close();
  });

  it('reports an activation failure before returning the problem response', async () => {
    const app = fastify();
    const failures: string[] = [];
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      activate: async () => {
        throw new Error('CODEX_START_FAILED');
      },
      reportFailure: (_operation, error) =>
        failures.push(error instanceof Error ? error.message : 'unknown'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default' },
    });
    expect(response.statusCode).toBe(500);
    expect(failures).toEqual(['CODEX_START_FAILED']);
    await app.close();
  });
});
