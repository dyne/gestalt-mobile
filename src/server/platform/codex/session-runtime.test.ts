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
        onServerRequest: () => () => {},
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
          onServerRequest: () => () => {},
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

  it('resumes a persisted thread in a relaunched app-server process', async () => {
    const calls: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const restored = await runtime.restore(
      {
        id: 'session-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        threadId: 'thread-1',
        state: 'ready',
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
    expect(calls).toEqual(['initialize', 'thread/resume']);
    expect(restored).toMatchObject({
      id: 'session-1',
      state: 'ready',
      threadId: 'thread-1',
      updatedAt: 'after',
    });
  });

  it('keeps a Codex approval request pending until the relay resolves it', async () => {
    let requestListener:
      ((value: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    const pending: unknown[] = [];
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => () => {},
          onServerRequest: (listener) => {
            requestListener = listener;
            return () => {};
          },
        },
        close: () => {},
      }),
      undefined,
      undefined,
      (sessionId, request) => {
        pending.push({ sessionId, request });
        return true;
      },
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
    const result = requestListener?.({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    expect(pending).toEqual([
      {
        sessionId: 'session-1',
        request: { id: 7, method: 'item/commandExecution/requestApproval', params: {} },
      },
    ]);
    runtime.resolveServerRequest('session-1', '7', { decision: 'approved' });
    await expect(result).resolves.toEqual({ decision: 'approved' });
  });

  it('rejects an unsupported Codex server request instead of leaving it pending', async () => {
    let requestListener:
      ((value: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => () => {},
          onServerRequest: (listener) => {
            requestListener = listener;
            return () => {};
          },
        },
        close: () => {},
      }),
      undefined,
      undefined,
      () => false,
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

    await expect(
      requestListener?.({ id: 8, method: 'unsupported/request', params: {} }),
    ).rejects.toThrow('CODEX_SERVER_REQUEST_UNSUPPORTED');
  });
});
