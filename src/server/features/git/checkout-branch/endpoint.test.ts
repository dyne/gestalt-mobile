import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerCheckoutBranch } from './endpoint.js';

describe('POST /api/sessions/:id/git/checkout', () => {
  it('checks out a selected local branch for the session workspace', async () => {
    const app = fastify();
    const checkout = vi.fn(async () => undefined);
    registerCheckoutBranch(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      checkout,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/git/checkout',
      payload: { branch: 'topic' },
    });
    expect(response.statusCode).toBe(202);
    expect(checkout).toHaveBeenCalledWith('/workspace', 'topic');
    await app.close();
  });
});
