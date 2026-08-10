/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createAuthClient } from './auth-client.js';

describe('auth client', () => {
  it('uses same-origin credentials for status, ceremonies, verification, and logout', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const client = createAuthClient(async (path, init) => {
      requests.push({ path: String(path), init });
      if (String(path) === '/api/auth/status')
        return new Response(
          JSON.stringify({ status: 'locked', publicOrigin: 'https://relay.test' }),
        );
      if (String(path).endsWith('/options'))
        return new Response(JSON.stringify({ options: { challenge: 'challenge' } }));
      if (String(path) === '/api/auth/logout') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ status: 'authenticated' }));
    });
    await client.status();
    await client.registrationOptions('ticket');
    await client.verifyRegistration({ id: 'id' } as never, 'Laptop');
    await client.loginOptions();
    await client.verifyLogin({ id: 'id' } as never);
    await client.logout();
    expect(requests.map(({ path, init }) => [path, init?.credentials])).toEqual([
      ['/api/auth/status', 'same-origin'],
      ['/api/auth/register/options', 'same-origin'],
      ['/api/auth/register/verify', 'same-origin'],
      ['/api/auth/login/options', 'same-origin'],
      ['/api/auth/login/verify', 'same-origin'],
      ['/api/auth/logout', 'same-origin'],
    ]);
  });

  it('rejects malformed status responses', async () => {
    const client = createAuthClient(
      async () => new Response(JSON.stringify({ status: 'unexpected' })),
    );
    await expect(client.status()).rejects.toThrow('AUTH_RESPONSE_INVALID');
  });

  it('preserves a structured server problem code and falls back to the HTTP status', async () => {
    const coded = createAuthClient(
      async () =>
        new Response(JSON.stringify({ code: 'REGISTRATION_VERIFICATION_FAILED' }), {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    await expect(coded.registrationOptions()).rejects.toThrow(
      'REGISTRATION_VERIFICATION_FAILED',
    );

    const malformed = createAuthClient(
      async () => new Response('not json', { status: 502 }),
    );
    await expect(malformed.registrationOptions()).rejects.toThrow('AUTH_REQUEST_FAILED_502');
  });
});
