/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { composeRelayApp } from './composition.js';
import { createRelyingPartyConfig } from './config.js';
import { deviceNickname } from './features/auth/domain/device-nickname.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  webAuthnCredentialId,
} from './features/auth/domain/identifiers.js';
import { RelaySession } from './features/sessions/model/relay-session.js';
import {
  authorizationDatabasePath,
  SqliteAuthorizationStore,
} from './platform/auth/sqlite-authorization-store.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';

function previewRequest(
  port: number,
  path: string,
  options: { cookie?: string; code?: string; origin?: string } = {},
): Promise<{ status?: number; body: string; cookie?: string }> {
  const origin = new URL(options.origin ?? 'https://preview.example');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.code ? 'POST' : 'GET',
        headers: {
          host: origin.host,
          ...(options.code ? { origin: origin.origin } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      async (response) => {
        let body = '';
        for await (const chunk of response) body += String(chunk);
        resolve({
          status: response.statusCode,
          body,
          cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
        });
      },
    );
    req.once('error', reject);
    req.end(options.code);
  });
}

async function listenUpstream(body: string) {
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= new Promise<void>((resolve) => server.close(() => resolve())));
  onTestFinished(close);
  return { port: (server.address() as AddressInfo).port, close };
}

it('reloads independent preview gateways on two relays without replacing the active chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-preview-reload-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const relyingParty = createRelyingPartyConfig('https://relay.example');
  const otherRelyingParty = createRelyingPartyConfig('https://relay.example:8443');
  const otherOrigin = 'https://other-preview.example';
  const home = join(root, 'home');
  const dataDir = join(root, 'relay');
  const workspaceRoot = join(root, 'workspaces');
  await mkdir(join(workspaceRoot, 'project'), { recursive: true });
  const store = new SqliteAuthorizationStore(home, relyingParty);
  const deviceId = authorizedDeviceId('fixture-device');
  try {
    const owner = store.initializeOwner(new Uint8Array(32).fill(1));
    store.claimFirstDevice(owner, {
      id: deviceId,
      credentialId: webAuthnCredentialId('fixture-credential'),
      publicKey: new Uint8Array([1]),
      deviceType: 'singleDevice',
      backedUp: false,
      counter: 0,
      transports: ['internal'],
      nickname: deviceNickname('Fixture device'),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.saveSession(authorizationSessionId('fixture-login'), {
      deviceId,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  } finally {
    store.close();
  }
  const options: Parameters<typeof composeRelayApp>[0] = {
    root: workspaceRoot,
    dataDir,
    homeDirectory: home,
    relyingParty,
    installedCodexVersion: null,
    testRunnerEnabled: false,
    profiles: {
      list: async () => [],
      require: async () => {
        throw new Error('PROFILE_NOT_FOUND');
      },
    },
  };
  const app = await composeRelayApp(options);
  onTestFinished(() => app.close());
  const [first, second, initial, replacement, otherGateway] = await Promise.all([
    listenUpstream('first dev server'),
    listenUpstream('second dev server'),
    listenUpstream(''),
    listenUpstream(''),
    listenUpstream(''),
  ]);
  await Promise.all([initial.close(), replacement.close(), otherGateway.close()]);
  const other = await composeRelayApp({
    ...options,
    dataDir: join(root, 'other-relay'),
    relyingParty: otherRelyingParty,
    preview: { origin: otherOrigin, port: first.port, targetPort: second.port },
  });
  onTestFinished(() => other.close());
  await app.ready();

  const headers = {
    cookie: 'gestalt_mobile_session=fixture-login',
    origin: relyingParty.publicOrigin,
  };
  const bootstrap = () =>
    app.inject({
      url: '/api/bootstrap',
      headers,
    });
  const bootstrapOther = () =>
    other.inject({
      url: '/api/bootstrap',
      headers: { ...headers, origin: otherRelyingParty.publicOrigin },
    });
  const before = await bootstrap();
  expect(before.statusCode).toBe(200);
  expect(before.json().capabilities).not.toHaveProperty('preview');
  const sessionId = 'preview-session';
  const now = new Date().toISOString();
  const db = openRelayDatabase(join(dataDir, 'relay.sqlite'));
  try {
    const session = RelaySession.fromExistingThread({
      id: sessionId,
      workspaceId: before.json().workspaces[0].children[0].id,
      workspacePath: join(workspaceRoot, 'project'),
      profile: 'default',
      provider: 'codex',
      threadId: 'preview-thread',
      now,
    }).restore(now);
    new SqliteSessionRepository(db).save(session.snapshot);
  } finally {
    db.close();
  }

  async function openPreview(port: number): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/preview`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const url = new URL(response.json().url);
    expect(url.origin).toBe('https://preview.example');
    const exchange = await previewRequest(port, url.pathname, { code: url.hash.slice(1) });
    expect(exchange.status).toBe(204);
    expect(exchange.cookie).toBeDefined();
    return exchange.cookie!;
  }

  const path = join(dirname(authorizationDatabasePath(home)), 'preview.json');
  const writeConfig = (gatewayPort: number, targetPort: number) =>
    writeFile(
      path,
      JSON.stringify([
        {
          relayOrigin: relyingParty.publicOrigin,
          origin: 'https://preview.example',
          gatewayPort,
          targetPort,
        },
        {
          relayOrigin: otherRelyingParty.publicOrigin,
          origin: otherOrigin,
          gatewayPort: otherGateway.port,
          targetPort: second.port,
        },
      ]),
      { mode: 0o600 },
    );
  await writeConfig(initial.port, first.port);
  await other.ready();
  await expect(
    previewRequest(otherGateway.port, '/.gestalt-preview', { origin: otherOrigin }),
  ).resolves.toMatchObject({ status: 200 });

  const enabled = await Promise.all([bootstrap(), bootstrapOther()]);
  expect(enabled.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(enabled.map((response) => response.json().capabilities.preview)).toEqual([true, true]);
  await expect(previewRequest(otherGateway.port, '/.gestalt-preview')).resolves.toMatchObject({
    status: 421,
  });
  const oldCookie = await openPreview(initial.port);
  await expect(previewRequest(initial.port, '/', { cookie: oldCookie })).resolves.toMatchObject({
    status: 200,
    body: 'first dev server',
  });

  await writeConfig(replacement.port, second.port);
  const changed = await Promise.all([bootstrap(), bootstrap()]);
  expect(changed.map((response) => response.json().capabilities.preview)).toEqual([true, true]);
  expect(changed[0]?.json().sessions).toContainEqual(
    expect.objectContaining({ id: sessionId, threadId: 'preview-thread', desiredState: 'active' }),
  );
  await expect(previewRequest(initial.port, '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  await expect(previewRequest(replacement.port, '/', { cookie: oldCookie })).resolves.toMatchObject(
    {
      status: 401,
    },
  );
  const newCookie = await openPreview(replacement.port);
  await expect(previewRequest(replacement.port, '/', { cookie: newCookie })).resolves.toMatchObject(
    {
      status: 200,
      body: 'second dev server',
    },
  );

  await writeConfig(replacement.port, 3000);
  expect((await bootstrap()).json().capabilities).not.toHaveProperty('preview');
  await expect(previewRequest(replacement.port, '/')).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
  expect((await bootstrapOther()).json().capabilities.preview).toBe(true);
  await expect(
    previewRequest(otherGateway.port, '/.gestalt-preview', { origin: otherOrigin }),
  ).resolves.toMatchObject({ status: 200 });
});
