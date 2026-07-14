import { describe, expect, it } from 'vitest';

import { CodexSessionRuntime } from './session-runtime.js';

describe('CodexSessionRuntime', () => {
  it('initializes app-server, starts a thread, and returns a ready session', async () => {
    const calls: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        },
        onNotification: () => () => {},
      },
      close: () => {},
    }));
    const session = await runtime.start(
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        threadId: null,
        state: 'starting',
        desiredState: 'active',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'before',
        updatedAt: 'before',
      },
      'after',
    );
    expect(calls).toEqual(['initialize', 'thread/start']);
    expect(session).toMatchObject({ state: 'ready', threadId: 'thread-1', updatedAt: 'after' });
  });

  it('forwards app-server notifications with their relay session identity', async () => {
    let notify: ((value: { method: string; params: unknown }) => void) | undefined;
    const received: unknown[] = [];
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: (listener) => {
            notify = listener;
            return () => {};
          },
        },
        close: () => {},
      }),
      undefined,
      (sessionId, notification) => received.push({ sessionId, notification }),
    );
    await runtime.start(
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        threadId: null,
        state: 'starting',
        desiredState: 'active',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'before',
        updatedAt: 'before',
      },
      'after',
    );
    notify?.({ method: 'item/agentMessage/delta', params: { delta: 'hi' } });
    expect(received).toEqual([
      {
        sessionId: 'session-1',
        notification: { method: 'item/agentMessage/delta', params: { delta: 'hi' } },
      },
    ]);
  });
});
