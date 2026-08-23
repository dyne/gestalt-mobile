/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { composeRelayApp } from '../../src/server/composition.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  webAuthnCredentialId,
} from '../../src/server/features/auth/domain/identifiers.js';
import { deviceNickname } from '../../src/server/features/auth/domain/device-nickname.js';
import type { WebAuthnCeremonyService } from '../../src/server/features/auth/application/ports.js';
import {
  SqliteAuthorizationStore,
  authorizationDatabasePath,
} from '../../src/server/platform/auth/sqlite-authorization-store.js';
import { migrate } from '../../src/server/platform/persistence/migrate.js';
import { openRelayDatabase } from '../../src/server/platform/persistence/sqlite.js';

const paths: string[] = [];
const rp = {
  publicOrigin: 'http://localhost:3000',
  rpId: 'localhost',
  rpName: 'Gestalt Mobile' as const,
};
const expiresAt = '2026-09-01T00:00:00.000Z';
const contentionRepetitions = process.env.AUTH_CONTENTION_STRESS === '1' ? 10 : 1;

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}

function opaque(byte: number) {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64url');
}

function device(id: string, nickname: string) {
  return {
    id: authorizedDeviceId(id),
    credentialId: webAuthnCredentialId(`credential-${id}`),
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname(nickname),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}

function fakeAppServer() {
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
        if (method === 'skills/list')
          return {
            data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
          };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}

const profiles = {
  list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
  require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
};

async function compose(
  root: string,
  dataDir: string,
  homeDirectory: string,
  authorizationWebauthn?: WebAuthnCeremonyService,
  entropy = 1,
) {
  let next = entropy;
  return composeRelayApp({
    root,
    dataDir,
    homeDirectory,
    relyingParty: rp,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: () => fakeAppServer(),
    authorizationWebauthn,
    authorizationRandomBytes: (length) => new Uint8Array(length).fill(next++),
  });
}

const proof = (id: string) => ({
  id,
  rawId: id,
  type: 'public-key' as const,
  response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
  clientExtensionResults: {},
});
const webauthn: WebAuthnCeremonyService = {
  registrationOptions: async (input) => ({
    challenge: Buffer.from(input.challenge).toString('base64url'),
  }),
  authenticationOptions: async () => ({}),
  verifyRegistration: async ({ response }) => ({
    credentialId: webAuthnCredentialId((response as { id: string }).id),
    publicKey: new Uint8Array([9]),
    counter: 0,
    userVerified: true,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
  }),
  verifyAuthentication: async () => {
    throw new Error('unused');
  },
};

function cookie(response: Response, name: string) {
  const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.split(';', 1)[0].slice(name.length + 1);
}

function address(app: Awaited<ReturnType<typeof composeRelayApp>>) {
  const value = app.server.address();
  if (!value || typeof value === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${value.port}`;
}

async function request(base: string, path: string, session: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie: `gestalt_mobile_session=${session}`,
      ...(init.method && init.method !== 'GET' ? { origin: rp.publicOrigin } : {}),
      ...init.headers,
    },
  });
}

type ContentionMode = 'first-claim' | 'revoke';

async function runContenders(home: string, mode: ContentionMode, ids: readonly string[]) {
  const workers = ids.map(() =>
    fork(new URL('./auth-store-contention.worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  );
  const stop = () => workers.forEach((worker) => worker.kill());
  try {
    const contenders = workers.map((worker, index) => {
      let ready: () => void;
      let result: (outcome: string) => void;
      let fail: (error: Error) => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const resultPromise = new Promise<string>((resolve, reject) => {
        result = resolve;
        fail = reject;
      });
      const timeout = setTimeout(
        () => fail(new Error(`contention worker ${index} timed out`)),
        10_000,
      );
      worker.once('error', () => fail(new Error(`contention worker ${index} failed`)));
      worker.once('exit', (code) => {
        if (code !== 0) fail(new Error(`contention worker ${index} exited without a result`));
      });
      worker.on('message', (message: { type?: string; outcome?: string; reason?: string }) => {
        if (message.type === 'ready') ready();
        else if (message.type === 'result' && message.outcome) {
          clearTimeout(timeout);
          result(message.outcome);
        } else if (message.type === 'error')
          fail(new Error(`contention worker ${index} failed: ${message.reason ?? 'unknown'}`));
      });
      worker.send({ home, mode, id: ids[index] });
      return { ready: readyPromise, result: resultPromise };
    });
    await Promise.all(contenders.map((contender) => contender.ready));
    workers.forEach((worker) => worker.send('go'));
    return await Promise.all(contenders.map((contender) => contender.result));
  } finally {
    stop();
  }
}

describe('shared authorization across independently composed relays', () => {
  it('establishes credentials and sessions by live A/B HTTP ceremonies', async () => {
    const [rootA, rootB, dataA, dataB, home] = await Promise.all([
      temporary('gestalt-live-a-'),
      temporary('gestalt-live-b-'),
      temporary('gestalt-live-data-a-'),
      temporary('gestalt-live-data-b-'),
      temporary('gestalt-live-home-'),
    ]);
    await Promise.all([mkdir(join(rootA, 'workspace')), mkdir(join(rootB, 'workspace'))]);
    const [first, second] = await Promise.all([
      compose(rootA, dataA, home, webauthn, 10),
      compose(rootB, dataB, home, webauthn, 40),
    ]);
    await Promise.all([
      first.listen({ host: '127.0.0.1', port: 0 }),
      second.listen({ host: '127.0.0.1', port: 0 }),
    ]);
    const [baseA, baseB] = [address(first), address(second)];
    const firstOptions = await fetch(`${baseA}/api/auth/register/options`, {
      method: 'POST',
      headers: { origin: rp.publicOrigin, 'content-type': 'application/json' },
      body: '{}',
    });
    const firstSession = await fetch(`${baseA}/api/auth/register/verify`, {
      method: 'POST',
      headers: {
        origin: rp.publicOrigin,
        cookie: `gestalt_mobile_registration=${cookie(firstOptions, 'gestalt_mobile_registration')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ response: proof('credential-a'), nickname: 'Phone' }),
    });
    const sessionA = cookie(firstSession, 'gestalt_mobile_session');
    expect((await request(baseB, '/api/bootstrap', sessionA)).status).toBe(200);
    const workspace = (await request(baseB, '/api/bootstrap', sessionA)).json() as Promise<{
      workspaces: Array<{ children: Array<{ id: string }> }>;
    }>;
    const created = await request(baseB, '/api/sessions', sessionA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: (await workspace).workspaces[0]?.children[0]?.id,
        profile: 'default',
      }),
    });
    const socket = new WebSocket(
      `${baseB.replace('http', 'ws')}/api/sessions/${((await created.json()) as { id: string }).id}/events?after=0`,
      { headers: { origin: rp.publicOrigin, cookie: `gestalt_mobile_session=${sessionA}` } },
    );
    await once(socket, 'open');
    socket.close();
    const ticket = await request(baseA, '/api/auth/enrollment-tickets', sessionA, {
      method: 'POST',
    }).then((response) => response.json() as Promise<{ ticket: string }>);
    const secondOptions = await fetch(`${baseB}/api/auth/register/options`, {
      method: 'POST',
      headers: { origin: rp.publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentTicket: ticket.ticket }),
    });
    await fetch(`${baseB}/api/auth/register/verify`, {
      method: 'POST',
      headers: {
        origin: rp.publicOrigin,
        cookie: `gestalt_mobile_registration=${cookie(secondOptions, 'gestalt_mobile_registration')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ response: proof('credential-b'), nickname: 'Laptop' }),
    });
    expect(await (await request(baseA, '/api/auth/devices', sessionA)).json()).toMatchObject({
      devices: [{ nickname: 'Phone' }, { nickname: 'Laptop' }],
    });
    await first.close();
    await second.close();
  });
  it('shares A-created sessions and device mutations with B over distinct ports', async () => {
    const [rootA, rootB, dataA, dataB, home] = await Promise.all([
      temporary('gestalt-multi-root-a-'),
      temporary('gestalt-multi-root-b-'),
      temporary('gestalt-multi-data-a-'),
      temporary('gestalt-multi-data-b-'),
      temporary('gestalt-multi-home-'),
    ]);
    await Promise.all([mkdir(join(rootA, 'workspace')), mkdir(join(rootB, 'workspace'))]);
    const primary = device('primary', 'Primary');
    const secondary = device('secondary', 'Secondary');
    const sessionA = opaque(11);
    const sessionSecondary = opaque(12);
    const seed = new SqliteAuthorizationStore(home, rp);
    const owner = seed.initializeOwner(new Uint8Array(32).fill(1));
    expect(seed.claimFirstDevice(owner, primary)).toBe('claimed');
    expect(seed.authorizeDevice(secondary)).toBe('authorized');
    seed.saveSession(authorizationSessionId(sessionA), { deviceId: primary.id, expiresAt });
    seed.saveSession(authorizationSessionId(sessionSecondary), {
      deviceId: secondary.id,
      expiresAt,
    });
    seed.close();

    const [first, second] = await Promise.all([
      compose(rootA, dataA, home),
      compose(rootB, dataB, home),
    ]);
    await Promise.all([
      first.listen({ host: '127.0.0.1', port: 0 }),
      second.listen({ host: '127.0.0.1', port: 0 }),
    ]);
    const [baseA, baseB] = [address(first), address(second)];
    expect(baseA).not.toBe(baseB);
    expect((await request(baseB, '/api/bootstrap', sessionA)).status).toBe(200);

    const workspace = (await request(baseB, '/api/bootstrap', sessionA)).json() as Promise<{
      workspaces: Array<{ children: Array<{ id: string }> }>;
    }>;
    const workspaceId = (await workspace).workspaces[0]?.children[0]?.id;
    const created = await request(baseB, '/api/sessions', sessionA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, profile: 'default' }),
    });
    expect(created.status).toBe(202);
    const sessionId = ((await created.json()) as { id: string }).id;
    const socket = new WebSocket(
      `${baseB.replace('http', 'ws')}/api/sessions/${sessionId}/events?after=0`,
      {
        headers: { origin: rp.publicOrigin, cookie: `gestalt_mobile_session=${sessionA}` },
      },
    );
    await once(socket, 'open');
    socket.close();

    const renamed = await request(baseB, `/api/auth/devices/${secondary.id}`, sessionA, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: 'Travel laptop' }),
    });
    expect(renamed.status).toBe(204);
    expect((await request(baseA, '/api/auth/devices', sessionA)).status).toBe(200);
    expect(await (await request(baseA, '/api/auth/devices', sessionA)).json()).toMatchObject({
      devices: [{ nickname: 'Primary' }, { nickname: 'Travel laptop' }],
    });

    expect(
      (await request(baseA, `/api/auth/devices/${secondary.id}`, sessionA, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect((await request(baseB, '/api/bootstrap', sessionSecondary)).status).toBe(401);
    const inspector = new SqliteAuthorizationStore(home, rp);
    expect(inspector.findDeviceByCredentialId(secondary.credentialId)).toBeNull();
    inspector.close();

    await first.close();
    expect((await request(baseB, '/api/bootstrap', sessionA)).status).toBe(200);
    expect(
      (
        await request(baseB, `/api/auth/devices/${primary.id}`, sessionA, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nickname: 'Primary after A close' }),
        })
      ).status,
    ).toBe(204);
    expect(await (await request(baseB, '/api/auth/devices', sessionA)).json()).toMatchObject({
      devices: [{ nickname: 'Primary after A close' }],
    });
    await second.close();
    await expect(
      composeRelayApp({
        root: rootA,
        dataDir: dataA,
        homeDirectory: home,
        relyingParty: {
          publicOrigin: 'https://different.example',
          rpId: 'different.example',
          rpName: 'Gestalt Mobile',
        },
        profiles,
        installedCodexVersion: null,
      }),
    ).rejects.toThrow('hostname changed');
  });

  it.each(Array.from({ length: contentionRepetitions }, (_, index) => index + 1))(
    'preserves bootstrap and final-device invariants under barrier-synchronized concurrent processes %i',
    async () => {
      const home = await temporary('gestalt-multi-contention-');
      expect(await runContenders(home, 'first-claim', ['one', 'two'])).toEqual(
        expect.arrayContaining(['claimed', 'alreadyClaimed']),
      );
      const seeded = new SqliteAuthorizationStore(home, rp);
      expect(seeded.listAuthorizedDevices()).toHaveLength(1);
      const remaining = seeded.listAuthorizedDevices()[0];
      if (!remaining) throw new Error('first claim did not persist a device');
      const other =
        remaining.id === authorizedDeviceId('one') ? device('two', 'Two') : device('one', 'One');
      expect(seeded.authorizeDevice(other)).toBe('authorized');
      seeded.close();

      expect(await runContenders(home, 'revoke', [remaining.id, other.id])).toEqual(
        expect.arrayContaining(['revoked', 'finalDevice']),
      );
      const inspector = new SqliteAuthorizationStore(home, rp);
      expect(inspector.listAuthorizedDevices()).toHaveLength(1);
      inspector.close();
    },
    30_000,
  );

  it('boots an installed pre-auth relay without mutating its relay database', async () => {
    const [root, dataDir, home] = await Promise.all([
      temporary('gestalt-upgrade-root-'),
      temporary('gestalt-upgrade-data-'),
      temporary('gestalt-upgrade-home-'),
    ]);
    const relayPath = join(dataDir, 'relay.sqlite');
    const legacy = openRelayDatabase(relayPath);
    migrate(legacy);
    legacy.close();
    const before = await readFile(relayPath);
    await expect(readFile(authorizationDatabasePath(home))).rejects.toThrow();
    const app = await compose(root, dataDir, home);
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({ status: 'bootstrap' });
    expect(await readFile(relayPath)).toEqual(before);
    expect((await readFile(authorizationDatabasePath(home))).length).toBeGreaterThan(0);
    await app.close();
  });
});
