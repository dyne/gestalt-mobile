/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerListSessions } from './endpoint.js';

describe('GET /api/sessions', () => {
  it('returns durable relay sessions', async () => {
    const app = fastify();
    registerListSessions(app, { list: () => [{ id: 'session-1', state: 'ready' }] as never });
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'session-1', state: 'ready', resumeCommand: null }]);
    await app.close();
  });
  it('maps the current activity snapshot without collaboration prompts', async () => {
    const app = fastify();
    registerListSessions(app, {
      list: () => [{ id: 'session-1', state: 'ready', threadId: null }] as never,
      activity: () =>
        ({
          sessionId: 'session-1',
          root: { state: 'idle' },
          subagents: [],
          confidence: 'fresh',
        }) as never,
    });
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).json()).toMatchObject([
      { agentActivity: { root: { state: 'idle' }, subagents: [] } },
    ]);
    await app.close();
  });
  it('includes each session retained plan without changing durable session state', async () => {
    const app = fastify();
    registerListSessions(app, {
      list: () => [{ id: 'session-1', state: 'ready', threadId: null }] as never,
      plan: () =>
        ({
          title: 'Ship the session list',
          steps: [
            {
              id: 'layout',
              title: 'Layout',
              level: 1,
              state: 'WIP',
              priority: 'A',
              description: {},
              children: [],
            },
          ],
          totalSteps: 1,
          doneSteps: 0,
          allDone: false,
          currentStepId: 'layout',
        }) as never,
    });

    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).json()).toMatchObject([
      {
        id: 'session-1',
        plan: {
          title: 'Ship the session list',
          totalSteps: 1,
          doneSteps: 0,
          currentStepId: 'layout',
        },
      },
    ]);
    await app.close();
  });
});
