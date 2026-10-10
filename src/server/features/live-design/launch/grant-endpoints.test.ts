/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePreviewGrantStore } from '../../../platform/live-design/sqlite-preview-grant-store.js';
import { previewSecrets } from '../../../platform/live-design/preview-secrets.js';
import { exchangeDocument } from '../../../platform/live-design/exchange-document.js';
import { authorizedDeviceId, webAuthnCredentialId } from '../../auth/domain/identifiers.js';
import { previewAuthFixture, mobileOrigin, origin, launchBody } from '../preview-auth.fixture.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function minted(f: Awaited<ReturnType<typeof previewAuthFixture>>) {
  const response = await f.launch();
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { grantId: body.grantId as string, grant: body.grant as string };
}
function previewCookie(app: Awaited<ReturnType<FastifyInstance['inject']>>) {
  return String(app.headers['set-cookie']).split(';')[0]!;
}

describe('launch-grant-proof-replay-audience', () => {
  it('serves only the pinned public exchange document and rejects unexpected public paths/hosts', async () => {
    const f = await previewAuthFixture(cleanup);
    const page = await f.gateway.inject({
      url: '/__gestalt_live/auth',
      headers: { host: new URL(origin).host },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toBe(exchangeDocument(mobileOrigin).csp);
    expect(page.headers['cross-origin-opener-policy']).toBe('unsafe-none');
    expect(page.body).not.toContain('src=');
    expect(page.body).not.toContain('localhost');
    const wrongHost = await f.gateway.inject({
      url: '/__gestalt_live/auth',
      headers: { host: 'mobile.example.test', 'x-forwarded-host': new URL(origin).host },
    });
    expect(wrongHost.statusCode).toBe(421);
    expect(wrongHost.headers['cache-control']).toBe('no-store');
    expect(
      (
        await f.gateway.inject({
          url: '/__gestalt_live/unknown',
          headers: { host: new URL(origin).host },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('fails closed on an unavailable owner/auth store without leaking credentials into errors', async () => {
    const f = await previewAuthFixture(cleanup);
    const grant = await minted(f);
    const dependencies = {
      ...f.deps,
      owners: {
        read: () => {
          throw new Error(`private failure ${grant.grant}`);
        },
      },
    };
    const gateway = await f.preview(origin, dependencies);
    const failed = await f.exchange(grant, {}, gateway);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe('LIVE_AUTH_UNAVAILABLE');
    expect(failed.body).not.toContain(grant.grant);
    expect(failed.headers['set-cookie']).toBeUndefined();
    // A failed infrastructure check rolls back consumption; a recovered owner can exchange.
    expect((await f.exchange(grant)).statusCode).toBe(201);
  });
  it('authenticates the owner, exchanges with PKCE once, delivers only a private cookie and safe status', async () => {
    const f = await previewAuthFixture(cleanup);
    const response = await f.launch();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    const url = new URL(body.exchangeUrl);
    expect(url.search).toBe('');
    expect(url.hash).toContain(`grant=${body.grant}`);
    expect(url.hash).not.toContain(f.verifier);
    expect(body.expiresAt).toBe('2026-10-10T12:01:00.000Z');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    const grant = { grantId: body.grantId, grant: body.grant };
    const result = await f.exchange(grant);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({
      liveId: 'live',
      generation: 1,
      leaseExpiresAt: '2026-10-10T12:05:00.000Z',
      absoluteExpiresAt: '2026-10-10T13:00:00.000Z',
    });
    const cookie = String(result.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-gestalt_live_p9443=[A-Za-z0-9_-]{43};/);
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=300'])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain('Domain');
    expect((await f.exchange(grant)).statusCode).toBe(401);
    const state = await f.mobile.inject({
      url: '/api/sessions/relay/live',
      headers: { cookie: f.cookieHeader },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().leases).toHaveLength(1);
    expect(state.body).not.toContain(grant.grant);
    expect(state.body).not.toContain(f.verifier);
    expect(state.body).not.toContain(previewCookie(result).split('=')[1]);
  });
  it('rejects anonymous, other auth sessions, duplicate cookies and forged Mobile origins', async () => {
    const f = await previewAuthFixture(cleanup);
    expect((await f.launch(launchBody, { origin: mobileOrigin, cookie: '' })).statusCode).toBe(401);
    expect(
      (
        await f.launch(launchBody, {
          origin: mobileOrigin,
          cookie: `gestalt_mobile_session=${f.otherSession}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.launch(launchBody, {
          origin: mobileOrigin,
          cookie: `${f.cookieHeader}; ${f.cookieHeader}`,
        })
      ).statusCode,
    ).toBe(401);
    for (const badOrigin of ['null', 'https://mobile.example.test:444', origin, '']) {
      const response = await f.launch(launchBody, { origin: badOrigin, cookie: f.cookieHeader });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect((await f.launch({ ...launchBody, generation: 2 })).json().code).toBe(
      'LIVE_GENERATION_STALE',
    );
    expect((await f.launch({ ...launchBody, liveId: 'other' })).statusCode).toBe(404);
  });
  it('does not consume a grant for missing or wrong proof; never accepts unknown request fields or redirect destinations', async () => {
    const f = await previewAuthFixture(cleanup);
    const grant = await minted(f);
    expect((await f.exchange(grant, { codeVerifier: undefined })).statusCode).toBe(400);
    expect((await f.exchange(grant, { codeVerifier: previewSecrets.token() })).json().code).toBe(
      'LIVE_GRANT_INVALID',
    );
    expect((await f.exchange(grant, { returnTo: 'https://attacker.test' })).statusCode).toBe(400);
    expect((await f.launch({ ...launchBody, previewOrigin: origin })).statusCode).toBe(400);
    expect((await f.exchange(grant)).statusCode).toBe(201);
    const page = await f.gateway.inject({
      url: '/__gestalt_live/auth?returnTo=//attacker.test',
      headers: { host: new URL(origin).host },
    });
    expect(page.statusCode).toBe(400);
    expect(page.body).not.toContain('attacker.test');
  });
  it('atomically permits one exchange across independent controller connections', async () => {
    const f = await previewAuthFixture(cleanup);
    const second = new SqlitePreviewGrantStore(f.home);
    cleanup.push(() => second.close());
    const app = await f.preview(origin, { ...f.deps, store: second });
    const grant = await minted(f);
    const results = await Promise.all([f.exchange(grant), f.exchange(grant, {}, app)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 401]);
    expect(f.store.listLeases(f.audience().authSessionHash, 'relay')).toHaveLength(1);
  });
  it.each(['expiry', 'session', 'device', 'owner', 'generation', 'app', 'port', 'stop'])(
    'fails closed after %s changes',
    async (change) => {
      const f = await previewAuthFixture(cleanup);
      const grant = await minted(f);
      if (change === 'expiry') f.advance(60);
      if (change === 'session') f.auth.revokeSession(f.session, f.deps.now().toISOString());
      if (change === 'device') {
        f.auth.authorizeDevice({
          ...f.device,
          id: authorizedDeviceId('second'),
          credentialId: webAuthnCredentialId('second'),
        });
        f.auth.revokeDevice(f.device.id, f.deps.now().toISOString());
      }
      if (change === 'owner')
        f.setAudience({ ...f.audience(), authSessionHash: previewSecrets.hash(f.otherSession) });
      if (change === 'generation') f.setAudience({ ...f.audience(), generation: 2 });
      if (change === 'app') f.setAudience({ ...f.audience(), appId: 'other-app' });
      if (change === 'port')
        f.setAudience({ ...f.audience(), previewOrigin: 'https://preview.example.test:9444' });
      if (change === 'stop') f.setAudience({ ...f.audience(), active: false });
      const response = await f.exchange(grant);
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('LIVE_GRANT_INVALID');
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );
  it('rejects wrong listener port and origin independently of forged forwarding headers', async () => {
    const f = await previewAuthFixture(cleanup);
    const grant = await minted(f);
    const wrongOrigin = 'https://preview.example.test:9444';
    const wrongGateway = await f.preview(wrongOrigin);
    const wrong = await f.exchange(grant, {}, wrongGateway, {
      origin: wrongOrigin,
      host: new URL(wrongOrigin).host,
    });
    expect(wrong.statusCode).toBe(401);
    const forged = await f.gateway.inject({
      method: 'POST',
      url: '/__gestalt_live/exchange',
      headers: {
        host: 'attacker.test',
        origin,
        'x-forwarded-host': new URL(origin).host,
        forwarded: `host=${new URL(origin).host}`,
      },
      payload: { ...grant, codeVerifier: f.verifier },
    });
    expect(forged.statusCode).toBe(421);
    for (const badOrigin of ['null', mobileOrigin, wrongOrigin, ''])
      expect(
        (await f.exchange(grant, {}, f.gateway, { origin: badOrigin, host: new URL(origin).host }))
          .statusCode,
      ).toBe(403);
    expect((await f.exchange(grant)).statusCode).toBe(201);
  });
  it('logout immediately disables grant exchange and preview refresh while retaining existing 204', async () => {
    const f = await previewAuthFixture(cleanup);
    const live = await f.exchange(await minted(f));
    const grant = await minted(f);
    const logout = await f.mobile.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: mobileOrigin, cookie: f.cookieHeader },
    });
    expect(logout.statusCode).toBe(204);
    expect((await f.exchange(grant)).statusCode).toBe(401);
    const refresh = await f.gateway.inject({
      method: 'POST',
      url: '/__gestalt_live/lease',
      headers: { host: new URL(origin).host, origin, cookie: previewCookie(live) },
      payload: {},
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.headers['set-cookie']).toBeUndefined();
  });
  it('persists only hashes in private controller files and retains replay protection after reopen', async () => {
    const f = await previewAuthFixture(cleanup);
    const grant = await minted(f);
    const lease = await f.exchange(grant);
    const bytes = readFileSync(f.store.path).toString('latin1');
    for (const secret of [grant.grant, f.verifier, f.session, previewCookie(lease).split('=')[1]!])
      expect(bytes).not.toContain(secret);
    expect(statSync(f.store.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.home, '.codex-gestalt/gestalt-mobile')).mode & 0o777).toBe(0o700);
    const reopened = new SqlitePreviewGrantStore(f.home);
    cleanup.push(() => reopened.close());
    const app = await f.preview(origin, { ...f.deps, store: reopened });
    expect((await f.exchange(grant, {}, app)).statusCode).toBe(401);
    expect(reopened.listLeases(f.audience().authSessionHash, 'relay')).toHaveLength(1);
  });
  it('bounds launch and unauthenticated peer attempts without echoing tokens', async () => {
    const f = await previewAuthFixture(cleanup);
    for (let i = 0; i < 10; i++) expect((await f.launch()).statusCode).toBe(201);
    const denied = await f.launch();
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('60');
    f.advance(60);
    expect((await f.launch()).statusCode).toBe(201);
    const invalid = { grant: previewSecrets.token(), grantId: 'unknown' };
    for (let i = 0; i < 10; i++) expect((await f.exchange(invalid)).statusCode).toBe(401);
    const blocked = await f.exchange(invalid);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).not.toContain(invalid.grant);
  });
  it('limits bodies to 4 KiB and never includes bad input in errors', async () => {
    const f = await previewAuthFixture(cleanup);
    const response = await f.launch({ ...launchBody, secret: 'x'.repeat(5000) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('LIVE_INVALID_REQUEST');
    expect(response.body).not.toContain('xxx');
  });
});

describe('bounded lease and Mobile-only renewal', () => {
  it('renews at most every 60s; refresh only reads the deadline and requires the port cookie', async () => {
    const f = await previewAuthFixture(cleanup);
    const result = await f.exchange(await minted(f));
    const cookie = previewCookie(result);
    const state = await f.mobile.inject({
      url: '/api/sessions/relay/live',
      headers: { cookie: f.cookieHeader },
    });
    const leaseId = state.json().leases[0].leaseId;
    const renew = (session = f.cookieHeader) =>
      f.mobile.inject({
        method: 'POST',
        url: `/api/sessions/relay/live/leases/${leaseId}/renew`,
        headers: { origin: mobileOrigin, cookie: session },
        payload: { liveId: 'live', generation: 1 },
      });
    expect((await renew()).statusCode).toBe(429);
    expect((await renew(`gestalt_mobile_session=${f.otherSession}`)).statusCode).toBe(404);
    f.advance(60);
    const extended = await renew();
    expect(extended.statusCode).toBe(200);
    expect(extended.json().leaseExpiresAt).toBe('2026-10-10T12:06:00.000Z');
    const refresh = (cookies = cookie) =>
      f.gateway.inject({
        method: 'POST',
        url: '/__gestalt_live/lease',
        headers: { host: new URL(origin).host, origin, cookie: cookies },
        payload: {},
      });
    expect((await refresh()).headers['set-cookie']).toContain('Max-Age=300');
    expect((await refresh(`${cookie}; ${cookie}`)).statusCode).toBe(401);
    expect((await refresh(cookie.replace('p9443', 'p9444'))).statusCode).toBe(401);
    f.advance(300);
    expect((await refresh()).statusCode).toBe(401);
    expect((await renew()).json().code).toBe('LIVE_LEASE_EXPIRED');
  });
  it('caps recurring Mobile renewal at one hour and requires a new Open after expiry', async () => {
    const f = await previewAuthFixture(cleanup);
    const exchanged = await f.exchange(await minted(f));
    const leaseId = f.store.listLeases(f.audience().authSessionHash, 'relay')[0]!.leaseId;
    for (let elapsed = 240; elapsed < 3600; elapsed += 240) {
      f.advance(240);
      const response = await f.mobile.inject({
        method: 'POST',
        url: `/api/sessions/relay/live/leases/${leaseId}/renew`,
        headers: { origin: mobileOrigin, cookie: f.cookieHeader },
        payload: { liveId: 'live', generation: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(Date.parse(response.json().leaseExpiresAt)).toBeLessThanOrEqual(
        Date.parse('2026-10-10T13:00:00.000Z'),
      );
    }
    f.advance(240);
    const refresh = await f.gateway.inject({
      method: 'POST',
      url: '/__gestalt_live/lease',
      headers: { host: new URL(origin).host, origin, cookie: previewCookie(exchanged) },
      payload: {},
    });
    expect(refresh.statusCode).toBe(401);
    const expired = await f.mobile.inject({
      method: 'POST',
      url: `/api/sessions/relay/live/leases/${leaseId}/renew`,
      headers: { origin: mobileOrigin, cookie: f.cookieHeader },
      payload: { liveId: 'live', generation: 1 },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().code).toBe('LIVE_LEASE_EXPIRED');
    expect(f.store.listLeases(f.audience().authSessionHash, 'relay')[0]!.absoluteExpiresAt).toBe(
      '2026-10-10T13:00:00.000Z',
    );
  });
});
