/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import type { PlanStatusSource, PlanStatusUpdate } from '../../features/plans/application/ports.js';
import { GESTALT_QUIZ_TOOL_NAME, gestaltQuizDynamicTool, toQuizToolResponse } from '../../../shared/contracts/quiz.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
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

  it('writes each live-plan-derived thread name once and ignores metadata failures', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params });
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        },
        onNotification: () => () => {}, onServerRequest: () => () => {},
      }, close: () => {},
    }));
    await runtime.start({ id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default', threadId: null, state: 'starting', desiredState: 'active', activeTurnId: null, protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before' }, 'after');
    const plan = { title: 'Roadmap', totalSteps: 1, doneSteps: 0, allDone: false, currentStepId: 'l1', steps: [{ id: 'l1', title: 'Ship', level: 1 as const, state: 'WIP' as const, priority: 'A' as const, reviewStatus: 'UNREVIEWED' as const, description: {}, children: [] }] };
    await runtime.syncThreadPlanName('session-1', plan);
    await runtime.syncThreadPlanName('session-1', plan);
    expect(calls.filter((call) => call.method === 'thread/name/set')).toEqual([{ method: 'thread/name/set', params: { threadId: 'thread-1', name: 'Roadmap — L1 1/1' } }]);
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
        statusDirectory: `/private/${id}.json`,
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
        environment: { GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: '/private/session-1.json' },
      },
    ]);
    runtime.stop('session-1');
    expect(closed).toEqual(['session-1']);
  });

  it('releases a plan-status lease when skill resolution or synchronous launch fails', async () => {
    const closed: string[] = [];
    const source = {
      open: async ({ id }: { id: string; workspacePath: string }) => ({
        statusDirectory: `/private/${id}.json`,
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
      dynamicTools: [gestaltQuizDynamicTool],
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

  it.each(['stopped', 'released', 'attentionRequired'] as const)(
    'creates and binds a replacement for a missing rollout from %s',
    async (state) => {
      const calls: Array<{ method: string; params: unknown }> = [];
      const runtime = new CodexSessionRuntime(() => ({
        rpc: {
          request: async (method, params) => {
            calls.push({ method, params });
            if (method === 'thread/resume')
              throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
            if (method === 'thread/start') return { thread: { id: 'replacement-thread' } };
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {},
      }));
      const outcome = await runtime.restoreWithOutcome(
        {
          id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default',
          model: 'gpt-5.4', threadId: 'old-thread', state, desiredState: 'stopped', activeTurnId: null,
          protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before',
          effectiveSkillSelection: { selectedProfileName: 'focused', skills: [] },
          lastOrgPlan: { filename: 'plan.org', title: 'Plan' },
        },
        'after',
      );

      expect(outcome).toMatchObject({
        historyUnavailable: true,
        replacementCreated: true,
        session: { state: 'ready', threadId: 'replacement-thread', model: 'gpt-5.4' },
      });
      expect(calls.map((call) => call.method)).toEqual(['initialize', 'thread/resume', 'thread/start']);
      expect(calls.at(-1)?.params).toEqual({
        cwd: '/workspace', approvalPolicy: 'on-request', model: 'gpt-5.4', dynamicTools: [gestaltQuizDynamicTool],
      });
    },
  );

  it('does not create or bind a replacement for an unrelated resume failure', async () => {
    const calls: string[] = [];
    let closed = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/resume') throw new CodexJsonRpcError(-32600, 'invalid parameters');
          return {};
        },
        onNotification: () => () => {}, onServerRequest: () => () => {},
      },
      close: () => { closed += 1; },
    }));
    const original = {
      id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default',
      threadId: 'old-thread', state: 'released' as const, desiredState: 'stopped' as const, activeTurnId: null,
      protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before',
    };

    await expect(runtime.restoreWithOutcome(original, 'after')).rejects.toThrow('invalid parameters');
    expect(calls).toEqual(['initialize', 'thread/resume']);
    expect(closed).toBe(1);
    expect(original.threadId).toBe('old-thread');
  });

  it('cleans a failed replacement child and its status lease', async () => {
    const closed: string[] = [];
    const source: PlanStatusSource = {
      open: async () => ({ statusDirectory: '/private/session-1', close: () => closed.push('lease'), remove: async () => {} }),
      remove: async () => {}, closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) => {
            if (method === 'thread/resume') throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
            if (method === 'thread/start') throw new Error('replacement failed');
            return {};
          },
          onNotification: () => () => {}, onServerRequest: () => () => {},
        },
        close: () => closed.push('process'),
      }),
      undefined, undefined, undefined, undefined, undefined, source,
    );
    await expect(runtime.restoreWithOutcome({
      id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default',
      threadId: 'old-thread', state: 'attentionRequired', desiredState: 'stopped', activeTurnId: null,
      protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before',
    }, 'after')).rejects.toThrow('replacement failed');
    expect(closed).toEqual(['process', 'lease']);
  });

  it('disposes each status lease once on child exit and graceful stopAll shutdown', async () => {
    const closeCounts = new Map<string, number>();
    const exitListeners = new Map<string, () => void>();
    const sessions = ['session-a', 'session-b'];
    let launched = 0;
    const source: PlanStatusSource = {
      open: async (session) => ({
        statusDirectory: `/private/${session.id}.json`,
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
          planPath: `/workspace/${session.id}/plan.org`,
          reason: null,
          plan: {
            title: `Plan for ${session.id}`,
            steps: [],
            totalSteps: 1,
            doneSteps: 0,
            allDone: false,
            currentStepId: 'current',
          },
        });
        return { statusDirectory: `/private/${session.id}.json`, close: () => {}, remove: async () => {} };
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

  it('keeps a Codex quiz request pending until the relay resolves it with the dynamic-tool result', async () => {
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
      method: 'item/tool/call',
      params: {
        tool: GESTALT_QUIZ_TOOL_NAME,
        arguments: {
          questions: [
            {
              id: 'execution_mode',
              header: 'Execution mode',
              question: 'How should this plan run?',
              choices: [
                { label: 'Solo', description: 'One agent executes the plan.' },
                { label: 'Supervised multi-agent', description: 'A supervisor coordinates agents.' },
              ],
              allowCustom: false,
            },
          ],
        },
      },
    });
    expect(pending).toEqual([
      {
        sessionId: 'session-1',
        request: expect.objectContaining({ id: 7, method: 'item/tool/call' }),
      },
    ]);
    const response = toQuizToolResponse([{ id: 'execution_mode', answer: 'Supervised multi-agent' }]);
    expect(runtime.resolveServerRequest('session-1', '7', response)).toBe(true);
    expect(runtime.resolveServerRequest('session-1', '7', response)).toBe(false);
    await expect(result).resolves.toEqual(response);
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

  it('bounds server requests, times them out, and makes late resolutions harmless', async () => {
    vi.useFakeTimers();
    let requestListener: ((request: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) => method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => () => {},
          onServerRequest: (listener) => { requestListener = listener; return () => {}; },
        }, close: () => {},
      }),
      undefined, undefined, () => true, undefined, undefined, undefined, undefined, undefined, 10, 1,
    );
    await runtime.start({ id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default', threadId: null, state: 'starting', desiredState: 'active', activeTurnId: null, protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before' }, 'after');
    const pending = requestListener!({ id: 1, method: 'item/tool/call', params: {} });
    await expect(requestListener!({ id: 2, method: 'item/tool/call', params: {} })).rejects.toThrow('CODEX_SERVER_REQUEST_LIMIT');
    const timeout = expect(pending).rejects.toThrow('CODEX_SERVER_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await timeout;
    expect(runtime.resolveServerRequest('session-1', '1', {})).toBe(false);
    vi.useRealTimers();
  });

  it('removes listeners and leases exactly once when exit races release', async () => {
    let exit: (() => void) | undefined;
    let listeners = 0;
    let leases = 0;
    const source: PlanStatusSource = {
      open: async () => ({ statusDirectory: '/private/session-1', close: () => { leases += 1; }, remove: async () => {} }),
      remove: async () => {}, closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) => method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => { listeners += 1; return () => { listeners -= 1; }; },
          onServerRequest: () => { listeners += 1; return () => { listeners -= 1; }; },
        }, close: () => {}, onExit: (listener) => { exit = listener; listeners += 1; return () => { listeners -= 1; }; },
      }),
      undefined, undefined, undefined, undefined, undefined, source,
    );
    await runtime.start({ id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default', threadId: null, state: 'starting', desiredState: 'active', activeTurnId: null, protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before' }, 'after');
    exit?.();
    await runtime.release('session-1');
    expect({ listeners, leases }).toEqual({ listeners: 0, leases: 1 });
  });

  it('caches an unsupported optional thread-name capability', async () => {
    let nameCalls = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'thread/name/set') { nameCalls += 1; throw new CodexJsonRpcError(-32601, 'method not found'); }
          return {};
        }, onNotification: () => () => {}, onServerRequest: () => () => {},
      }, close: () => {},
    }));
    await runtime.start({ id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default', threadId: null, state: 'starting', desiredState: 'active', activeTurnId: null, protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before' }, 'after');
    const plan = { title: 'Plan', totalSteps: 1, doneSteps: 0, allDone: false, currentStepId: 'l1', steps: [{ id: 'l1', title: 'Ship', level: 1 as const, state: 'WIP' as const, priority: 'A' as const, reviewStatus: 'UNREVIEWED' as const, description: {}, children: [] }] };
    await runtime.syncThreadPlanName('session-1', plan);
    await runtime.syncThreadPlanName('session-1', plan);
    expect(nameCalls).toBe(1);
  });
});
