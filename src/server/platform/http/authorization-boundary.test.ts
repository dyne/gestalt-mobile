/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerAuthorizationBoundary } from './authorization-boundary.js';

const origin = 'https://gestalt.example:8443';
const clock = { now: () => new Date('2026-08-02T00:00:00.000Z') };

async function app() {
  const instance = fastify();
  let calls = 0;
  registerAuthorizationBoundary(instance, {
    repository: {
      sessionDevice: (token: string) => (token === 'live' ? ('device' as never) : null),
    } as never,
    clock,
    publicOrigin: origin,
  });
  instance.get('/api/auth/status', async () => ({ status: 'locked' }));
  instance.post('/api/auth/login/options', async () => ({ options: {} }));
  instance.post('/api/auth/login/verify', async () => ({ status: 'authenticated' }));
  instance.post('/api/auth/logout', async () => ({ status: 'locked' }));
  instance.post('/api/auth/register/options', async () => ({ options: {} }));
  instance.post('/api/auth/register/verify', async () => ({ status: 'authenticated' }));
  instance.get('/api/bootstrap', async () => {
    calls++;
    return {};
  });
  instance.post('/api/protected', async () => {
    calls++;
    return {};
  });
  return { instance, calls: () => calls };
}

describe('authorization boundary', () => {
  it.each([
    ['GET', '/api/auth/status'],
    ['POST', '/api/auth/login/options'],
    ['POST', '/api/auth/login/verify'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/register/options'],
    ['POST', '/api/auth/register/verify'],
  ] as const)(
    'keeps %s %s public when an exact origin is supplied for a mutation',
    async (method, url) => {
      const { instance } = await app();
      const response = await instance.inject({
        method,
        url,
        headers: method === 'GET' ? {} : { origin },
      });
      expect(response.statusCode).toBe(200);
      await instance.close();
    },
  );

  it.each(['missing', 'malformed', 'whitespace', 'empty', 'duplicate', 'expired', 'revoked'])(
    'rejects a %s session before protected handlers run',
    async (kind) => {
      const { instance, calls } = await app();
      const cookie =
        kind === 'missing'
          ? undefined
          : kind === 'empty'
            ? 'gestalt_mobile_session='
            : kind === 'duplicate'
              ? 'gestalt_mobile_session=live; gestalt_mobile_session=other'
              : kind === 'whitespace'
                ? 'gestalt_mobile_session= forged'
                : `gestalt_mobile_session=${kind === 'malformed' ? '%' : kind}`;
      const response = await instance.inject({
        method: 'GET',
        url: '/api/bootstrap',
        headers: cookie ? { cookie } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_REQUIRED');
      expect(calls()).toBe(0);
      await instance.close();
    },
  );

  it('allows a live shared cookie and enforces exact origins before every unsafe handler', async () => {
    const { instance, calls } = await app();
    const live = await instance.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { cookie: 'gestalt_mobile_session=live' },
    });
    expect(live.statusCode).toBe(200);
    for (const candidate of [
      undefined,
      'https://gestalt.example',
      'https://attacker.gestalt.example:8443',
      'http://gestalt.example:8443',
      'https://gestalt.example:443',
    ]) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/protected',
        headers: {
          cookie: 'gestalt_mobile_session=live',
          host: 'gestalt.example:8443',
          referer: origin,
          forwarded: 'host=gestalt.example:8443;proto=https',
          'x-forwarded-host': 'gestalt.example:8443',
          'x-forwarded-proto': 'https',
          ...(candidate === undefined ? {} : { origin: candidate }),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(calls()).toBe(1);
    const allowed = await instance.inject({
      method: 'POST',
      url: '/api/protected',
      headers: { cookie: 'gestalt_mobile_session=live', origin },
    });
    expect(allowed.statusCode).toBe(200);
    expect(calls()).toBe(2);
    await instance.close();
  });

  it.each([
    '/api/auth/login/options',
    '/api/auth/login/verify',
    '/api/auth/register/options',
    '/api/auth/register/verify',
  ])('rejects missing and spoofed origins before public ceremony handler %s', async (url) => {
    const { instance } = await app();
    for (const headers of [
      { host: 'gestalt.example:8443', referer: origin, forwarded: 'proto=https' },
      { origin: 'https://gestalt.example.evil:8443' },
    ]) {
      const response = await instance.inject({ method: 'POST', url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ORIGIN_NOT_ALLOWED');
    }
    await instance.close();
  });
});
