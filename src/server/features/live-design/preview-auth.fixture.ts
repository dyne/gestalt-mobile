/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import cookie from '@fastify/cookie';
import fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAuthorizationStore } from '../../platform/auth/sqlite-authorization-store.js';
import { SqlitePreviewGrantStore } from '../../platform/live-design/sqlite-preview-grant-store.js';
import {
  previewAuthentication,
  previewSecrets,
} from '../../platform/live-design/preview-secrets.js';
import { exchangeDocument } from '../../platform/live-design/exchange-document.js';
import { PreviewConnections } from '../../platform/live-design/preview-connections.js';
import { buildApp } from '../../app.js';
import { deviceNickname } from '../auth/domain/device-nickname.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  webAuthnCredentialId,
} from '../auth/domain/identifiers.js';
import { registerPreviewExchange } from './exchange/endpoint.js';
import type { LiveAudience, PreviewGrantDependencies } from './application/ports.js';
export const mobileOrigin = 'https://mobile.example.test';
export const origin = 'https://preview.example.test:9443';
const rp = {
  publicOrigin: mobileOrigin,
  rpId: 'mobile.example.test',
  rpName: 'Gestalt Mobile' as const,
};
const verifier = previewSecrets.token();
export const launchBody = {
  liveId: 'live',
  generation: 1,
  codeChallenge: previewSecrets.challenge(verifier),
  codeChallengeMethod: 'S256',
};
export async function previewAuthFixture(
  cleanup: (() => void | Promise<void>)[],
  revalidationMs = 5000,
) {
  const home = mkdtempSync(join(tmpdir(), 'live-auth-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const auth = new SqliteAuthorizationStore(home, rp);
  cleanup.push(() => auth.close());
  const owner = auth.initializeOwner(new Uint8Array(32).fill(1));
  const device = {
    id: authorizedDeviceId('device'),
    credentialId: webAuthnCredentialId('credential'),
    publicKey: new Uint8Array([1]),
    counter: 0,
    version: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname('Device'),
    createdAt: '2026-10-10T12:00:00.000Z',
  };
  auth.claimFirstDevice(owner, device);
  const session = authorizationSessionId(previewSecrets.token());
  auth.saveSession(session, { deviceId: device.id, expiresAt: '2026-10-11T12:00:00.000Z' });
  const otherSession = authorizationSessionId(previewSecrets.token());
  auth.saveSession(otherSession, { deviceId: device.id, expiresAt: '2026-10-11T12:00:00.000Z' });
  let time = Date.parse('2026-10-10T12:00:00.000Z');
  let audience: (LiveAudience & { active: boolean }) | null = {
    relayId: 'relay',
    liveId: 'live',
    generation: 1,
    appId: 'app',
    previewOrigin: origin,
    authSessionHash: previewSecrets.hash(session),
    deviceId: device.id,
    active: true,
  };
  const store = new SqlitePreviewGrantStore(home);
  cleanup.push(() => store.close());
  const deps: PreviewGrantDependencies = {
    store,
    authentication: previewAuthentication(auth),
    secrets: previewSecrets,
    owners: { read: (id) => (id === 'relay' ? audience : null) },
    now: () => new Date(time),
    mobileOrigin,
  };
  const connections = new PreviewConnections(deps, revalidationMs);
  deps.revocations = connections;
  cleanup.push(() => connections.close());
  const mobile = await buildApp({
    liveDesign: deps,
    auth: {
      repository: auth,
      revocations: {
        sessionRevoked: (session) =>
          connections.revoke({ authSessionHash: previewSecrets.hash(session) }),
        deviceRevoked: (deviceId) => connections.revoke({ deviceId }),
      },
      clock: { now: deps.now },
      relyingParty: rp,
      random: { bytes: (length) => new Uint8Array(length) },
      identifiers: { sessionId: () => session, deviceId: () => device.id },
      webauthn: {
        registrationOptions: async () => ({}),
        authenticationOptions: async () => ({}),
        verifyRegistration: async () => {
          throw new Error('Unused test ceremony');
        },
        verifyAuthentication: async () => {
          throw new Error('Unused test ceremony');
        },
      },
    },
    health: {
      read: async () => ({
        status: 'ok' as const,
        version: 'test',
        codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        providers: { codex: { available: true }, kimi: { available: false } },
      }),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  cleanup.push(() => mobile.close());
  async function preview(boundOrigin = origin, dependencies = deps) {
    const app = fastify({ logger: false });
    await app.register(cookie);
    registerPreviewExchange(app, {
      ...dependencies,
      boundOrigin,
      document: exchangeDocument(mobileOrigin),
    });
    cleanup.push(() => app.close());
    return app;
  }
  const gateway = await preview();
  const cookieHeader = `gestalt_mobile_session=${session}`;
  const launch = (
    payload: Record<string, unknown> = launchBody,
    headers = { origin: mobileOrigin, cookie: cookieHeader },
    url = '/api/sessions/relay/live/launch-grants',
  ) => mobile.inject({ method: 'POST', url, headers, payload });
  const exchange = (
    grant: { grant: string; grantId: string },
    extra: Record<string, unknown> = {},
    app = gateway,
    headers = { origin, host: new URL(origin).host },
  ) =>
    app.inject({
      method: 'POST',
      url: '/__gestalt_live/exchange',
      headers,
      payload: { ...grant, codeVerifier: verifier, ...extra },
    });
  return {
    home,
    verifier,
    connections,
    auth,
    store,
    deps,
    mobile,
    gateway,
    preview,
    session,
    otherSession,
    device,
    cookieHeader,
    launch,
    exchange,
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
    setAudience: (value: typeof audience) => {
      audience = value;
    },
    audience: () => audience!,
  };
}
