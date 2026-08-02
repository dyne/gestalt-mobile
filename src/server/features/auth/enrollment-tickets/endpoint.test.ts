/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import cookie from '@fastify/cookie';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { authorizationSessionId, type AuthorizationSessionId, type EnrollmentTicketId } from '../domain/identifiers.js';
import { registerCreateEnrollmentTicket } from './endpoint.js';
import { registerEnrollmentTicketStatus } from './status/endpoint.js';
import { registerCancelEnrollmentTicket } from './cancel/endpoint.js';

describe('create enrollment ticket endpoint', () => {
  it('returns a 32-byte opaque ticket once, with its only URL occurrence in a fragment', async () => {
    const app = fastify();
    await app.register(cookie);
    const issued: Array<{ ticket: string; session: string; expiresAt: string }> = [];
    registerCreateEnrollmentTicket(app, {
      repository: {
        sessionDevice: (session: AuthorizationSessionId) => session === authorizationSessionId('creator-secret') ? ('device' as never) : null,
        issueEnrollmentTicket: (ticket: EnrollmentTicketId, session: AuthorizationSessionId, expiresAt: string) => issued.push({ ticket, session, expiresAt }),
      } as never,
      clock: { now: () => new Date('2026-08-02T00:00:00.000Z') },
      random: { bytes: (length) => new Uint8Array(length).map((_, index) => index) },
      relyingParty: { publicOrigin: 'https://relay.example:8443' },
    });
    const response = await app.inject({ method: 'POST', url: '/api/auth/enrollment-tickets', headers: { cookie: 'gestalt_mobile_session=creator-secret' } });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { ticket: string; url: string; expiresAt: string };
    expect(Buffer.from(body.ticket, 'base64url')).toHaveLength(32);
    expect(body.url).toBe(`https://relay.example:8443/#enroll=${body.ticket}`);
    expect(new URL(body.url).search).toBe('');
    expect(new URL(body.url).hash).toBe(`#enroll=${body.ticket}`);
    expect(body.expiresAt).toBe('2026-08-02T00:10:00.000Z');
    expect(issued).toEqual([{ ticket: body.ticket, session: 'creator-secret', expiresAt: body.expiresAt }]);
    await app.close();
  });

  it('does not mint a ticket without a live creator session', async () => {
    const app = fastify();
    await app.register(cookie);
    let issued = false;
    registerCreateEnrollmentTicket(app, {
      repository: { sessionDevice: () => null, issueEnrollmentTicket: () => { issued = true; } } as never,
      clock: { now: () => new Date('2026-08-02T00:00:00.000Z') },
      random: { bytes: (length) => new Uint8Array(length) },
      relyingParty: { publicOrigin: 'https://relay.example' },
    });
    expect((await app.inject({ method: 'POST', url: '/api/auth/enrollment-tickets' })).statusCode).toBe(401);
    expect(issued).toBe(false);
    await app.close();
  });

  it('exposes only tokenless current status and truthful cancel responses for a live creator session', async () => {
    const app = fastify();
    await app.register(cookie);
    let status: 'none' | 'pending' | 'used' | 'expired' = 'pending';
    let cancelled = false;
    const repository = {
      sessionDevice: (session: AuthorizationSessionId) => session === authorizationSessionId('creator-secret') ? ('device' as never) : null,
      enrollmentTicketStatus: () => status,
      cancelEnrollmentTicket: () => { cancelled = true; if (status === 'pending') status = 'none'; return status === 'none'; },
    };
    const deps = { repository: repository as never, clock: { now: () => new Date('2026-08-02T00:00:00.000Z') } };
    registerEnrollmentTicketStatus(app, deps);
    registerCancelEnrollmentTicket(app, deps);
    const headers = { cookie: 'gestalt_mobile_session=creator-secret' };
    expect((await app.inject({ method: 'GET', url: '/api/auth/enrollment-tickets/current', headers })).json()).toEqual({ status: 'pending' });
    const cancelledResponse = await app.inject({ method: 'DELETE', url: '/api/auth/enrollment-tickets/current', headers });
    expect(cancelledResponse.json()).toEqual({ status: 'none' });
    expect(cancelled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/auth/enrollment-tickets/current', headers })).json()).toEqual({ status: 'none' });
    for (const unchanged of ['used', 'expired', 'none'] as const) {
      status = unchanged;
      const response = await app.inject({ method: 'DELETE', url: '/api/auth/enrollment-tickets/current', headers });
      expect(response.json()).toEqual({ status: unchanged });
    }
    expect((await app.inject({ method: 'GET', url: '/api/auth/enrollment-tickets/current' })).statusCode).toBe(401);
    await app.close();
  });
});
