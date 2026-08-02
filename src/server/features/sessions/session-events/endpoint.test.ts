/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../../app.js';
import { SqliteAuthorizationStore } from '../../../platform/auth/sqlite-authorization-store.js';
import { authorizationSessionDevice } from '../../../platform/http/authorization-boundary.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../../auth/domain/identifiers.js';
import { deviceNickname } from '../../auth/domain/device-nickname.js';
import { registerSessionEvents } from './endpoint.js';

describe('session event WebSocket', () => {
  it('fails closed for malformed, duplicate, expired, and revoked shared-store cookies without consulting relay state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gestalt-ws-auth-'));
    let now = '2026-08-02T00:00:00.000Z';
    const rp = {
      publicOrigin: 'https://gestalt.example:8443',
      rpId: 'gestalt.example',
      rpName: 'Gestalt Mobile' as const,
    };
    const first = new SqliteAuthorizationStore(home, rp);
    const second = new SqliteAuthorizationStore(home, rp);
    const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array([1]) };
    const device = {
      id: authorizedDeviceId('device'),
      credentialId: webAuthnCredentialId('credential'),
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'] as const,
      deviceType: 'singleDevice' as const,
      backedUp: false,
      nickname: deviceNickname('Device'),
      createdAt: now,
    };
    first.initializeOwner(owner.userHandle);
    first.claimFirstDevice(owner, device);
    first.saveSession(authorizationSessionId('live'), {
      deviceId: device.id,
      expiresAt: '2026-08-02T00:00:00.020Z',
    });
    let exists = 0;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: () => {
        exists++;
        return true;
      },
      since: () => [],
      subscribe: () => () => {},
      publicOrigin: rp.publicOrigin,
      authorized: (cookie) =>
        Boolean(
          authorizationSessionDevice(cookie, {
            repository: first,
            clock: { now: () => new Date(now) },
          }),
        ),
      heartbeatIntervalMs: 10,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const reject = async (headers: { origin?: string; cookie?: string }) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/sessions/secret/events`, {
        headers: headers as Record<string, string>,
      });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 25);
        socket.once('error', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    };
    for (const headers of [
      {},
      { origin: rp.publicOrigin },
      { origin: rp.publicOrigin, cookie: 'gestalt_mobile_session=%' },
      {
        origin: rp.publicOrigin,
        cookie: 'gestalt_mobile_session=live; gestalt_mobile_session=other',
      },
      { origin: 'https://gestalt.example.evil:8443', cookie: 'gestalt_mobile_session=live' },
    ])
      await reject(headers);
    expect(exists).toBe(0);
    now = '2026-08-02T00:00:00.020Z';
    await reject({ origin: rp.publicOrigin, cookie: 'gestalt_mobile_session=live' });
    expect(exists).toBe(0);
    first.saveSession(authorizationSessionId('revoked'), {
      deviceId: device.id,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    second.revokeSession(authorizationSessionId('revoked'), now);
    await reject({ origin: rp.publicOrigin, cookie: 'gestalt_mobile_session=revoked' });
    expect(exists).toBe(0);
    let subscriptions = 0;
    let unsubscribes = 0;
    first.saveSession(authorizationSessionId('fresh'), {
      deviceId: device.id,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    const revalidationApp = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(revalidationApp, {
      exists: () => true,
      since: () => [],
      subscribe: () => {
        subscriptions++;
        return () => {
          unsubscribes++;
        };
      },
      publicOrigin: rp.publicOrigin,
      authorized: (cookie) =>
        Boolean(
          authorizationSessionDevice(cookie, {
            repository: first,
            clock: { now: () => new Date(now) },
          }),
        ),
      heartbeatIntervalMs: 10,
    });
    await revalidationApp.listen({ host: '127.0.0.1', port: 0 });
    const listening = revalidationApp.server.address();
    if (!listening || typeof listening === 'string') throw new Error('Expected TCP listener');
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${listening.port}/api/sessions/session/events`, {
        headers: { origin: rp.publicOrigin, cookie: `gestalt_mobile_session=${token}` },
      });
      await once(socket, 'open');
      return socket;
    };
    const expires = await connect('fresh');
    now = '2026-09-01T00:00:00.000Z';
    await once(expires, 'close');
    await vi.waitFor(() => expect(unsubscribes).toBe(1));
    expect(subscriptions).toBe(1);
    now = '2026-08-02T00:00:00.000Z';
    first.saveSession(authorizationSessionId('revalidate-revoked'), {
      deviceId: device.id,
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    const revokedSocket = await connect('revalidate-revoked');
    second.revokeSession(authorizationSessionId('revalidate-revoked'), now);
    await once(revokedSocket, 'close');
    await vi.waitFor(() => expect(unsubscribes).toBe(2));
    expect(subscriptions).toBe(2);
    await revalidationApp.close();
    first.close();
    second.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  it('authorizes exact-origin upgrades before revealing session existence and revalidates a live socket', async () => {
    let existsCalls = 0;
    let live = true;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: () => {
        existsCalls++;
        return true;
      },
      since: () => [],
      subscribe: () => () => {},
      publicOrigin: 'https://gestalt.example:8443',
      authorized: (cookie) => cookie === 'gestalt_mobile_session=live' && live,
      heartbeatIntervalMs: 10,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const rejected = async (headers: Record<string, string>) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/nonexistent/events?after=0`,
        { headers },
      );
      await once(socket, 'error');
    };
    await rejected({ origin: 'https://attacker.example', cookie: 'gestalt_mobile_session=live' });
    await rejected({ origin: 'https://gestalt.example:8443' });
    expect(existsCalls).toBe(0);
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/session-1/events?after=0`,
      {
        headers: { origin: 'https://gestalt.example:8443', cookie: 'gestalt_mobile_session=live' },
      },
    );
    await once(socket, 'open');
    live = false;
    await once(socket, 'close');
    await app.close();
  });

  it('replays retained events in sequence and streams live events', async () => {
    const listeners = new Set<
      (event: {
        sessionId: string;
        sequence: number;
        type: string;
        occurredAt: string;
        payload: unknown;
      }) => void
    >();
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: (id) => id === 'session-1',
      since: () => [
        { sessionId: 'session-1', sequence: 1, type: 'replayed', occurredAt: 't', payload: {} },
      ],
      subscribe: (_id, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/session-1/events?after=0`,
    );
    const first = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
    await once(socket, 'open');
    expect(await first).toMatchObject({ type: 'relay.event', event: { sequence: 1 } });
    const second = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
    listeners.forEach((listener) =>
      listener({ sessionId: 'session-1', sequence: 2, type: 'live', occurredAt: 't', payload: {} }),
    );
    expect(await second).toMatchObject({ type: 'relay.event', event: { sequence: 2 } });
    socket.close();
    await app.close();
  });

  it('instructs a pruned client to resync at the current sequence', async () => {
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: () => true,
      since: () => [
        { sessionId: 'session-1', sequence: 4, type: 'retained', occurredAt: 't', payload: {} },
      ],
      subscribe: () => () => {},
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/session-1/events?after=1`,
    );
    const message = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
    expect(await message).toEqual({ type: 'relay.resyncRequired', currentSequence: 4 });
    socket.close();
    await app.close();
  });

  it('replays ordered full plan replacements and close events only to their owning session', async () => {
    const events = [
      {
        sessionId: 'session-a',
        sequence: 1,
        type: 'plan.updated',
        occurredAt: 't1',
        payload: {
          title: 'A complete replacement',
          steps: [],
          totalSteps: 1,
          doneSteps: 1,
          allDone: true,
          currentStepId: 'done',
        },
      },
      { sessionId: 'session-a', sequence: 2, type: 'plan.closed', occurredAt: 't2', payload: {} },
      {
        sessionId: 'session-b',
        sequence: 1,
        type: 'plan.updated',
        occurredAt: 't3',
        payload: {
          title: 'Other session plan',
          steps: [],
          totalSteps: 1,
          doneSteps: 0,
          allDone: false,
          currentStepId: 'current',
        },
      },
    ];
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: (id) => id === 'session-a' || id === 'session-b',
      since: (id, after) =>
        events.filter((event) => event.sessionId === id && event.sequence > after),
      subscribe: () => () => {},
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const receive = async (sessionId: string, after: number, expected: number) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=${after}`,
      );
      const messages: Array<{
        type: string;
        event: { type: string; sequence: number; payload: unknown };
      }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      await vi.waitFor(() => expect(messages).toHaveLength(expected));
      socket.close();
      return messages;
    };
    const replay = await receive('session-a', 0, 2);
    expect(replay).toEqual([
      expect.objectContaining({
        type: 'relay.event',
        event: expect.objectContaining({
          sequence: 1,
          type: 'plan.updated',
          payload: expect.objectContaining({
            title: 'A complete replacement',
            allDone: true,
            currentStepId: 'done',
          }),
        }),
      }),
      expect.objectContaining({
        type: 'relay.event',
        event: expect.objectContaining({ sequence: 2, type: 'plan.closed', payload: {} }),
      }),
    ]);
    expect(await receive('session-a', 1, 1)).toMatchObject([
      { event: { sequence: 2, type: 'plan.closed' } },
    ]);
    expect(await receive('session-b', 0, 1)).toMatchObject([
      { event: { sequence: 1, type: 'plan.updated', payload: { title: 'Other session plan' } } },
    ]);
    await app.close();
  });
});
