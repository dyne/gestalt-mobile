/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerGetActiveOrgPlanAttention } from './endpoint.js';

describe('get active Org Plan attention endpoint', () => {
  it('returns only the typed active attention snapshot', async () => {
    const app = fastify();
    registerGetActiveOrgPlanAttention(app, {
      exists: (id) => id === 'session',
      reader: {
        active: () => ({
          requestId: 'request',
          turnId: 'turn',
          requestedAt: 'now',
          attention: {
            reason: 'hardBlock',
            summary: 'A dependency is unavailable.',
            requestedAction: 'Restore it.',
            resumeCondition: 'dependencyInstalled',
          },
        }),
      },
    });
    expect((await app.inject('/api/sessions/session/attention')).json()).toEqual({
      requestId: 'request',
      turnId: 'turn',
      requestedAt: 'now',
      attention: expect.objectContaining({ reason: 'hardBlock' }),
    });
    await app.close();
  });

  it('maps absent attention and sessions to stable problems', async () => {
    const app = fastify();
    registerGetActiveOrgPlanAttention(app, {
      exists: (id) => id === 'session',
      reader: { active: () => null },
    });
    expect((await app.inject('/api/sessions/session/attention')).json()).toMatchObject({
      code: 'ORG_PLAN_ATTENTION_NOT_ACTIVE',
    });
    expect((await app.inject('/api/sessions/missing/attention')).json()).toEqual({
      code: 'SESSION_NOT_FOUND',
    });
    await app.close();
  });
});
