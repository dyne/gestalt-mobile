/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerResolveOrgPlanAttention } from './endpoint.js';

const payload = { operationKey: 'same-key', action: 'resume', guidance: 'Continue safely.' };
describe('resolve Org Plan attention endpoint', () => {
  it.each([
    ['accepted', 202, { accepted: true, replayed: false, resolvedAt: 'now' }],
    ['replayed', 202, { accepted: true, replayed: true, resolvedAt: 'now' }],
    ['noActive', 404, { code: 'ORG_PLAN_ATTENTION_NOT_ACTIVE' }],
    ['staleOperation', 409, { code: 'ATTENTION_OPERATION_STALE' }],
    ['writerUnavailable', 409, { code: 'ATTENTION_WRITER_UNAVAILABLE' }],
    ['writerCleared', 409, { code: 'ATTENTION_WRITER_CLEARED' }],
    ['legacyUnsupported', 409, { code: 'ATTENTION_LEGACY_UNSUPPORTED' }],
  ] as const)('maps %s safely', async (kind, status, body) => {
    const app = fastify();
    registerResolveOrgPlanAttention(app, {
      resolver: {
        resolve: async () =>
          kind === 'accepted' || kind === 'replayed' ? { kind, resolvedAt: 'now' } : { kind },
      },
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/attention/r/resolve',
      payload,
    });
    expect(result.statusCode).toBe(status);
    expect(result.json()).toEqual(body);
    await app.close();
  });
  it('rejects malformed operation keys and never forwards guidance directly', async () => {
    const app = fastify();
    let calls = 0;
    registerResolveOrgPlanAttention(app, {
      resolver: {
        resolve: async () => {
          calls++;
          return { kind: 'noActive' as const };
        },
      },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions/s/attention/r/resolve',
          payload: { ...payload, operationKey: 'bad key' },
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toBe(0);
    await app.close();
  });
});
