/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

import { buildApp } from '../../dist/server/server/app.js';
import { createRelyingPartyConfig } from '../../dist/server/server/config.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
} from '../../dist/server/server/features/auth/domain/identifiers.js';
import { PreviewService } from '../../dist/server/server/features/previews/application/service.js';
import { SimpleWebAuthnAdapter } from '../../dist/server/server/platform/auth/simple-webauthn-adapter.js';
import { SqliteAuthorizationStore } from '../../dist/server/server/platform/auth/sqlite-authorization-store.js';
import { createPreviewGateway } from '../../dist/server/server/platform/previews/gateway.js';
import { FilesystemSkillProfileStore } from '../../dist/server/server/platform/skills/filesystem-skill-profile-store.js';

const homeDirectory = process.env.GESTALT_REAL_AUTH_HOME;
const dataDirectory = process.env.GESTALT_REAL_AUTH_DATA;
const staticDir = process.env.GESTALT_REAL_AUTH_STATIC;
if (!homeDirectory || !dataDirectory || !staticDir)
  throw new Error('Missing isolated real-auth paths');
await mkdir(homeDirectory, { recursive: true });
await mkdir(dataDirectory, { recursive: true });

const relyingParty = createRelyingPartyConfig('http://localhost:4173');
const repository = new SqliteAuthorizationStore(homeDirectory, relyingParty);
repository.initializeOwner(randomBytes(32));
const skillProfiles = new FilesystemSkillProfileStore(homeDirectory);
const events = new Set(['websocket-session']);
const previewOrigin = 'http://127.0.0.1:4174';
const upstream = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/sign-in') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in to the preview');
    return;
  }
  response
    .writeHead(200, { 'content-type': 'text/html' })
    .end(
      '<!doctype html><title>Preview sign-in</title>' +
        '<form method="post" action="/sign-in"><button>Sign in to the preview</button></form>',
    );
});
const upstreamReady = once(upstream, 'listening');
upstream.listen(0, '127.0.0.1');
await upstreamReady;
const preview = new PreviewService({
  sessionActive: (id) => events.has(id),
  loginValid: (id) => repository.sessionDevice(id, new Date().toISOString()) !== null,
  now: Date.now,
  token: () => randomBytes(32).toString('base64url'),
});
const previewGateway = createPreviewGateway(
  { origin: previewOrigin, port: 4174, targetPort: upstream.address().port },
  preview,
);
const app = await buildApp({
  health: {
    read: async () => ({
      status: 'ok',
      version: 'test',
      codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
    }),
  },
  logger: console,
  staticDir,
  auth: {
    repository,
    clock: { now: () => new Date() },
    random: { bytes: (length) => randomBytes(length) },
    identifiers: {
      sessionId: () => authorizationSessionId(randomBytes(32).toString('base64url')),
      deviceId: () => authorizedDeviceId(randomUUID()),
    },
    webauthn: new SimpleWebAuthnAdapter(),
    relyingParty,
  },
  bootstrap: {
    workspaces: { list: async () => [] },
    profiles: { list: async () => [] },
    sessions: { list: () => [] },
    protocolCompatible: true,
  },
  sessionEvents: {
    exists: (id) => events.has(id),
    since: () => [],
    subscribe: () => () => {},
  },
  preview: { service: preview, origin: previewOrigin },
  // The authenticated client normally reads this production-backed profile route.
  skills: {
    workspaces: {
      resolve: async () => {
        throw new Error('WORKSPACE_NOT_FOUND');
      },
    },
    profiles: {
      require: async () => {
        throw new Error('PROFILE_NOT_FOUND');
      },
    },
    catalog: {
      list: async () => ({ skills: [], errors: [] }),
      refresh: async () => ({ skills: [], errors: [] }),
    },
    selections: skillProfiles,
    listGlobalProfileNames: () => skillProfiles.listGlobalProfileNames(),
    readGlobalProfile: (name) => skillProfiles.readGlobalProfile(name),
    replaceGlobalProfile: (profile) => skillProfiles.replaceGlobalProfile(profile),
    deleteGlobalProfile: (name) => skillProfiles.deleteGlobalProfile(name),
    profilePath: (name) => skillProfiles.globalProfilePath(name),
  },
});
await previewGateway.start();
await app.listen({ host: '127.0.0.1', port: 4173 });
process.stderr.write('REAL_AUTH_READY\n');
const close = async () => {
  await Promise.all([
    app.close(),
    previewGateway.close(),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
