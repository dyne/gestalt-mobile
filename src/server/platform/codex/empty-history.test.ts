/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { registerGetHistory } from '../../features/sessions/get-history/endpoint.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
import { CodexSessionRuntime } from './session-runtime.js';

async function freshRuntime(
  failure = new CodexJsonRpcError(-32601, 'list_turns is not supported yet'),
) {
  let notify!: (event: { method: string; params: unknown }) => void;
  const metadata = vi.fn(async (): Promise<unknown> => ({
    thread: { id: 'fresh', status: { type: 'idle' } },
  }));
  const startTurn = vi.fn(async () => ({ turn: { id: 'first-turn' } }));
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'thread/start') return { thread: { id: 'fresh' } };
    if (method === 'turn/start') return startTurn();
    if (method === 'thread/read') {
      if ((params as { includeTurns: boolean }).includeTurns) throw failure;
      return metadata();
    }
    return {};
  });
  const runtime = new CodexSessionRuntime(() => ({
    rpc: {
      request,
      onNotification: (listener) => {
        notify = listener;
        return () => {};
      },
      onServerRequest: () => () => {},
    },
    close: vi.fn(),
  }));
  onTestFinished(() => runtime.stopAll());
  const session = await runtime.start(
    RelaySession.create({
      id: 's',
      provider: 'codex',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: 't',
    }).snapshot,
    't',
  );
  return { runtime, session, metadata, startTurn, request, notify, failure };
}

describe('untouched Codex thread history', () => {
  it.each([
    new CodexJsonRpcError(-32601, 'list_turns is not supported yet'),
    new CodexJsonRpcError(
      -32600,
      'thread fresh is not materialized yet; includeTurns is unavailable before first user message',
    ),
  ])('serves an empty HTTP snapshot for a confirmed untouched idle root: %s', async (failure) => {
    const { runtime, session, request } = await freshRuntime(failure);
    const app = fastify();
    onTestFinished(() => app.close());
    registerGetHistory(app, {
      find: () => session,
      read: (value) => runtime.readHistory(value),
      currentSequence: () => 7,
    });
    // Reopening/reloading the browser can read this endpoint repeatedly.
    for (let index = 0; index < 2; index++) {
      const response = await app.inject('/api/sessions/s/history');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [],
        turns: [],
        activeTurnId: null,
        baseSequence: 7,
      });
    }
    expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
  });

  it.each([
    { thread: { id: 'fresh', status: { type: 'active' } } },
    { thread: { id: 'other', status: { type: 'idle' } } },
    { thread: { id: 'fresh', status: { type: 'notLoaded' } } },
    { malformed: true },
  ])('preserves the failure when idle thread identity cannot be confirmed: %j', async (value) => {
    const { runtime, session, metadata, failure } = await freshRuntime();
    metadata.mockResolvedValue(value);
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
  });

  it('preserves generic provider failures even before the first turn', async () => {
    const failure = new CodexJsonRpcError(-32603, 'provider unavailable');
    const { runtime, session, metadata } = await freshRuntime(failure);
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
    expect(metadata).not.toHaveBeenCalled();
  });

  it('preserves failures after a turn is attempted, even when its response is lost', async () => {
    const { runtime, session, startTurn, metadata, failure } = await freshRuntime();
    startTurn.mockRejectedValue(new Error('response lost'));
    await expect(runtime.startTurn(session, 'hello', undefined, 't')).rejects.toThrow(
      'response lost',
    );
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
    expect(metadata).not.toHaveBeenCalled();
  });

  it('invalidates empty history on root turn notifications, but not child notifications', async () => {
    const { runtime, session, notify, failure } = await freshRuntime();
    notify({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
    await expect(runtime.readHistory(session)).resolves.toEqual({ turns: [], activeTurnId: null });
    notify({ method: 'turn/started', params: { threadId: 'fresh', turn: { id: 'root-turn' } } });
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
  });

  it('does not publish an empty snapshot if a turn starts during the metadata read', async () => {
    const { runtime, session, metadata, failure } = await freshRuntime();
    metadata.mockImplementationOnce(async () => {
      await runtime.startTurn(session, 'hello', undefined, 't');
      return { thread: { id: 'fresh', status: { type: 'idle' } } };
    });
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
  });

  it('does not assume a resumed thread or detached reader has empty history', async () => {
    const { runtime, session, metadata, failure } = await freshRuntime();
    await runtime.restore(session, 'later');
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
    runtime.stop(session.id);
    await expect(runtime.readHistory(session)).rejects.toBe(failure);
    expect(metadata).not.toHaveBeenCalled();
  });
});
