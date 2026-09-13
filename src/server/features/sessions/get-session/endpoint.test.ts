/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
  it('includes a redacted activity snapshot when supplied by the session port', async () => {
    const app = fastify();
    registerGetSession(
      app,
      () => ({ id: 's', threadId: null }) as never,
      () =>
        ({
          sessionId: 's',
          root: { state: 'working' },
          subagents: [],
          confidence: 'fresh',
        }) as never,
    );
    expect((await app.inject('/api/sessions/s')).json()).toMatchObject({
      agentActivity: { sessionId: 's', root: { state: 'working' }, subagents: [] },
    });
    await app.close();
  });
  it('strips private process fields from activity responses', async () => {
    const app = fastify();
    registerGetSession(
      app,
      () => ({ id: 's', threadId: null }) as never,
      () =>
        ({
          sessionId: 's',
          root: { state: 'idle' },
          aggregateSubagents: 'idle',
          confidence: 'fresh',
          subagents: [
            {
              id: 'child',
              state: 'idle',
              reason: 'unknown',
              observedAt: '2026-01-01T00:00:00Z',
              lastActivityAt: '2026-01-01T00:00:00Z',
              ownedProcesses: [
                {
                  processId: 'secret',
                  itemId: 'secret',
                  ownerThreadId: 'secret',
                  ownerTaskPath: 'secret',
                  ownership: 'executor',
                  state: 'running',
                  observedAt: '2026-01-01T00:00:00Z',
                  elapsedMs: 1,
                  cpuPercent: 1,
                  rssBytes: 1,
                },
              ],
            },
          ],
        }) as never,
    );
    const body = JSON.stringify((await app.inject('/api/sessions/s')).json());
    expect(body).not.toContain('secret');
    expect(body).toContain('"ownership":"executor"');
    await app.close();
  });
});
