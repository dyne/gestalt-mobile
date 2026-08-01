/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import type { PlanStatusSource, PlanStatusUpdate } from '../../features/plans/application/ports.js';
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

  it('applies the resolved override to both new and restored child launches', async () => {
    const launches: unknown[] = [];
    const resolvedSelections: unknown[] = [];
    const override = [{ path: '/skills/focused/SKILL.md', enabled: true }];
    const runtime = new CodexSessionRuntime(
      (input) => {
        launches.push(input);
        return {
          rpc: {
            request: async (method) =>
              method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {},
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      async (session) => {
        resolvedSelections.push(session.effectiveSkillSelection);
        return override;
      },
    );
    const base = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      state: 'starting' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
      effectiveSkillSelection: {
        selectedProfileName: 'focused',
        skills: [{ name: 'Focused', path: '/skills/focused/SKILL.md', enabled: true }],
      },
    };
    await runtime.start({ ...base, threadId: null }, 'after');
    await runtime.restore({ ...base, threadId: 'thread-1' }, 'after');
    expect(launches).toEqual([
      { profile: 'default', cwd: '/workspace', skillsConfig: override },
      { profile: 'default', cwd: '/workspace', skillsConfig: override },
    ]);
    expect(resolvedSelections).toEqual([
      base.effectiveSkillSelection,
      base.effectiveSkillSelection,
    ]);
  });

  it('injects one private plan-status path only into the session-owned app-server child', async () => {
    const launches: unknown[] = [];
    const closed: string[] = [];
    const source = {
      open: async ({ id }: { id: string; workspacePath: string }) => ({
        statusPath: `/private/${id}.json`,
        close: () => {
          closed.push(id);
        },
        remove: async () => {},
      }),
      remove: async () => {},
      closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      (input) => {
        launches.push(input);
        return {
          rpc: {
            request: async (method) =>
              method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {},
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source,
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
    expect(launches).toEqual([
      {
        profile: 'default',
        cwd: '/workspace',
        skillsConfig: undefined,
        environment: { GESTALT_MOBILE_ORG_PLAN_STATUS_FILE: '/private/session-1.json' },
      },
    ]);
    runtime.stop('session-1');
    expect(closed).toEqual(['session-1']);
  });

  it('releases a plan-status lease when skill resolution or synchronous launch fails', async () => {
    const closed: string[] = [];
    const source = {
      open: async ({ id }: { id: string; workspacePath: string }) => ({
        statusPath: `/private/${id}.json`,
        close: () => {
          closed.push(id);
        },
        remove: async () => {},
      }),
      remove: async () => {},
      closeAll: () => {},
    };
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: null,
      state: 'starting' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    const resolverFailure = new CodexSessionRuntime(
      () => {
        throw new Error('launch should not run');
      },
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error('skill failure');
      },
      source,
    );
    await expect(resolverFailure.start(session, 'after')).rejects.toThrow('skill failure');
    resolverFailure.stop('session-1');
    resolverFailure.stopAll();
    expect(closed).toEqual(['session-1']);

    const launchFailure = new CodexSessionRuntime(
      () => {
        throw new Error('launch failure');
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source,
    );
    await expect(
      launchFailure.restore({ ...session, threadId: 'thread-1', state: 'recovering' }, 'after'),
    ).rejects.toThrow('launch failure');
    launchFailure.stopAll();
    expect(closed).toEqual(['session-1', 'session-1']);
  });

  it('passes requested Codex settings through to thread start', async () => {
    let threadStartParams: unknown;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          if (method === 'thread/start') {
            threadStartParams = params;
            return { thread: { id: 'thread-1' } };
          }
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));

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
      { model: 'gpt-5.4', sandbox: 'workspace-write', approvalPolicy: 'never' },
    );

    expect(threadStartParams).toEqual({
      cwd: '/workspace',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('closes every active app-server when the relay shuts down', async () => {
    let closed = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {
        closed += 1;
      },
    }));
    const session = (id: string) => ({
      id,
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: null,
      state: 'starting' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    });

    await runtime.start(session('session-1'), 'after');
    await runtime.start(session('session-2'), 'after');
    runtime.stopAll();

    expect(closed).toBe(2);
  });

  it('unsubscribes a thread before closing its app-server process', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let closed = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params });
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {
        closed += 1;
      },
    }));

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
    await runtime.release('session-1');

    expect(calls.at(-1)).toEqual({
      method: 'thread/unsubscribe',
      params: { threadId: 'thread-1' },
    });
    expect(closed).toBe(1);
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

  it('disposes each status lease once on child exit and graceful stopAll shutdown', async () => {
    const closeCounts = new Map<string, number>();
    const exitListeners = new Map<string, () => void>();
    const sessions = ['session-a', 'session-b'];
    let launched = 0;
    const source: PlanStatusSource = {
      open: async (session) => ({
        statusPath: `/private/${session.id}.json`,
        close: () => closeCounts.set(session.id, (closeCounts.get(session.id) ?? 0) + 1),
        remove: async () => {},
      }),
      remove: async () => {},
      closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => {
        const sessionId = sessions[launched++]!;
        return {
          rpc: {
            request: async (method) =>
              method === 'thread/start' ? { thread: { id: `thread-${sessionId}` } } : {},
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {},
          onExit: (listener) => {
            exitListeners.set(sessionId, listener);
            return () => exitListeners.delete(sessionId);
          },
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source,
    );
    const session = (id: string) => ({
      id,
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: null,
      state: 'starting' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    });
    await runtime.start(session('session-a'), 'after');
    await runtime.start(session('session-b'), 'after');
    exitListeners.get('session-a')?.();
    runtime.stopAll();
    runtime.stop('session-b');
    expect([...closeCounts.entries()]).toEqual([
      ['session-a', 1],
      ['session-b', 1],
    ]);
  });

  it('opens an initial status read for restored sessions without sending another session update', async () => {
    const opened: string[] = [];
    const updates: Array<{ sessionId: string; update: PlanStatusUpdate }> = [];
    const source: PlanStatusSource = {
      open: async (session, listener) => {
        opened.push(session.id);
        listener({
          kind: 'updated',
          identity: 'restored-plan',
          plan: {
            title: `Plan for ${session.id}`,
            steps: [],
            totalSteps: 1,
            doneSteps: 0,
            allDone: false,
            currentStepId: 'current',
          },
        });
        return { statusPath: `/private/${session.id}.json`, close: () => {}, remove: async () => {} };
      },
      remove: async () => {},
      closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async () => ({}),
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {},
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source,
      (sessionId, update) => updates.push({ sessionId, update }),
    );
    await runtime.restore(
      {
        id: 'session-a',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace-a',
        profile: 'default',
        threadId: 'thread-a',
        state: 'recovering',
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
    expect(opened).toEqual(['session-a']);
    expect(updates).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        update: expect.objectContaining({
          kind: 'updated',
          plan: expect.objectContaining({ title: 'Plan for session-a' }),
        }),
      }),
    ]);
    runtime.stopAll();
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

  it('reads canonical items from a bound Codex thread', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    id: 'terminal-turn-1',
                    status: 'inProgress',
                    startedAt: 1_784_102_400,
                    completedAt: null,
                    items: [{ id: 'message-1', type: 'agentMessage' }],
                  },
                ],
              },
            };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const ready = await runtime.start(
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
    await expect(runtime.readHistory(ready)).resolves.toEqual({
      turns: [
        {
          items: [{ id: 'message-1', type: 'agentMessage' }],
          startedAt: 1_784_102_400,
          completedAt: null,
        },
      ],
      activeTurnId: 'terminal-turn-1',
    });
  });

  it('notifies the supervisor when an app-server process exits unexpectedly', async () => {
    let onExit: (() => void) | undefined;
    const exited: string[] = [];
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {},
        onExit: (listener) => {
          onExit = listener;
          return () => {};
        },
      }),
      undefined,
      undefined,
      undefined,
      (id) => exited.push(id),
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
    onExit?.();
    expect(exited).toEqual(['session-1']);
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
