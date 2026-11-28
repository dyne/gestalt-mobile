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
import { expect, it, onTestFinished, vi } from 'vitest';
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
import * as gatewayModule from './platform/previews/gateway.js';

function previewRequest(
  port: number,
  path: string,
  options: { cookie?: string; code?: string } = {},
): Promise<{ status?: number; body: string; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.code ? 'POST' : 'GET',
        headers: {
          host: 'preview.example',
          ...(options.code ? { origin: 'https://preview.example' } : {}),
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

async function listenUpstream(body: string): Promise<number> {
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

it('enables the fixed preview gateway from host configuration after the relay is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-preview-reload-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const relyingParty = createRelyingPartyConfig('https://relay.example');
  const home = join(root, 'home');
  const dataDir = join(root, 'relay');
  const workspaceRoot = join(root, 'workspaces');
  await mkdir(join(workspaceRoot, 'project'), { recursive: true });
  const realGateway = gatewayModule.createPreviewGateway;
  let livePort = 0;
  const createGateway = vi
    .spyOn(gatewayModule, 'createPreviewGateway')
    .mockImplementation((config, service) => {
      const gateway = realGateway({ ...config, port: 0 }, service);
      return {
        close: gateway.close,
        start: async () => (livePort = await gateway.start()),
      };
    });
  onTestFinished(() => createGateway.mockRestore());
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
  const app = await composeRelayApp({
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
  });
  onTestFinished(() => app.close());
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

  async function openPreview(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/preview`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const url = new URL(response.json().url);
    const exchange = await previewRequest(livePort, url.pathname, { code: url.hash.slice(1) });
    expect(exchange.status).toBe(204);
    expect(exchange.cookie).toBeDefined();
    return exchange.cookie!;
  }

  const path = join(dirname(authorizationDatabasePath(home)), 'preview.json');
  const writeConfig = (targetPort: number) =>
    writeFile(
      path,
      JSON.stringify({
        relayOrigin: relyingParty.publicOrigin,
        origin: 'https://preview.example',
        targetPort,
      }),
      { mode: 0o600 },
    );
  const firstPort = await listenUpstream('first dev server');
  const secondPort = await listenUpstream('second dev server');
  await writeConfig(firstPort);

  const after = await bootstrap();
  expect(after.statusCode).toBe(200);
  expect(after.json().capabilities.preview).toBe(true);
  expect(createGateway).toHaveBeenCalledTimes(1);
  expect(createGateway.mock.calls[0]?.[0]).toMatchObject({ port: 8080, targetPort: firstPort });
  const oldCookie = await openPreview();
  await expect(previewRequest(livePort, '/', { cookie: oldCookie })).resolves.toMatchObject({
    status: 200,
    body: 'first dev server',
  });

  await writeConfig(secondPort);
  const changed = await Promise.all([bootstrap(), bootstrap()]);
  expect(changed.map((response) => response.json().capabilities.preview)).toEqual([true, true]);
  expect(changed[0]?.json().sessions).toContainEqual(
    expect.objectContaining({ id: sessionId, threadId: 'preview-thread', desiredState: 'active' }),
  );
  expect(createGateway).toHaveBeenCalledTimes(2);
  expect(createGateway.mock.calls[1]?.[0]).toMatchObject({ port: 8080, targetPort: secondPort });
  await expect(previewRequest(livePort, '/', { cookie: oldCookie })).resolves.toMatchObject({
    status: 401,
  });
  const newCookie = await openPreview();
  await expect(previewRequest(livePort, '/', { cookie: newCookie })).resolves.toMatchObject({
    status: 200,
    body: 'second dev server',
  });

  await writeConfig(3000);
  expect((await bootstrap()).json().capabilities).not.toHaveProperty('preview');
  expect(createGateway).toHaveBeenCalledTimes(2);
  await expect(previewRequest(livePort, '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});
