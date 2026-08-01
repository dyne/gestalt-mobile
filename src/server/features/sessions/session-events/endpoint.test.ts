/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../../app.js';
import { registerSessionEvents } from './endpoint.js';

describe('session event WebSocket', () => {
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
      since: (id, after) => events.filter((event) => event.sessionId === id && event.sequence > after),
      subscribe: () => () => {},
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const receive = async (sessionId: string, after: number, expected: number) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=${after}`,
      );
      const messages: Array<{ type: string; event: { type: string; sequence: number; payload: unknown } }> = [];
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
