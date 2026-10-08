/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import cookie from '@fastify/cookie';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { setAuthCookie } from '../../src/server/features/auth/http/cookies.js';
import { registerAuthorizationBoundary } from '../../src/server/platform/http/authorization-boundary.js';
import examples from './live-authorization.json';

describe('existing Mobile controls required by the Live contract', () => {
  it.each([
    ['gestalt_mobile_login', 600],
    ['gestalt_mobile_registration', 600],
    ['gestalt_mobile_session', 2592000],
  ] as const)('serializes %s as a host-only HTTPS cookie', async (name, seconds) => {
    const app = fastify();
    await app.register(cookie);
    app.get('/cookie', async (_request, reply) => {
      setAuthCookie(reply, name, 'test-token', examples.mobileOrigin);
      return reply.code(204).send();
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/cookie' });
      const serialized = response.headers['set-cookie'];
      expect(serialized).toContain(`${name}=test-token`);
      expect(serialized).toContain(`Max-Age=${seconds}`);
      expect(serialized).toContain('Path=/');
      expect(serialized).toContain('Secure');
      expect(serialized).toContain('HttpOnly');
      expect(serialized).toContain('SameSite=Strict');
      expect(serialized).not.toMatch(/domain=/i);
    } finally {
      await app.close();
    }
  });

  it.each([
    examples.previewOrigin,
    'https://mobile.example.test:9443',
    'https://sibling.mobile.example.test',
    'null',
    undefined,
  ])('rejects unsafe Origin %s before the owner handler', async (origin) => {
    const app = fastify();
    let called = false;
    registerAuthorizationBoundary(app, {
      publicOrigin: examples.mobileOrigin,
      clock: { now: () => new Date('2026-10-08T00:00:00Z') },
      repository: { sessionDevice: () => 'owner-device' } as never,
    });
    app.post('/api/protected-live-contract', async () => {
      called = true;
      return {};
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/protected-live-contract',
        headers: {
          cookie: 'gestalt_mobile_session=valid',
          ...(origin === undefined ? {} : { origin }),
          referer: examples.mobileOrigin,
          'x-forwarded-host': 'mobile.example.test',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ORIGIN_NOT_ALLOWED');
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });
});
