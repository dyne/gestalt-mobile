/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import type { PlanStatusSource, PlanStatusUpdate } from '../../features/plans/application/ports.js';
import {
  GESTALT_QUIZ_TOOL_NAME,
  gestaltQuizDynamicTool,
  toQuizToolResponse,
} from '../../../shared/contracts/quiz.js';
import { gestaltOrgPlanAttentionDynamicTool } from '../../../shared/contracts/org-plan-attention.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
import { CodexSessionRuntime } from './session-runtime.js';

describe('CodexSessionRuntime', () => {
  it('keeps the resolved child model published by thread settings across history refreshes', async () => {
    let publishNotification:
      ((notification: { method: string; params: unknown }) => void) | undefined;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/resume' || method === 'initialize') return {};
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    items: [
                      {
                        id: 'spawn-1',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        model: null,
                        receiverThreadIds: ['child-1'],
                      },
                    ],
                  },
                ],
              },
            };
          if (method === 'thread/list')
            return {
              data: [{ id: 'child-1', status: { type: 'active' }, agentRole: 'worker' }],
            };
          return {};
        },
        onNotification: (listener) => {
          publishNotification = listener;
          return () => {};
        },
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'resolved-child-model',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    publishNotification?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 'child-1',
        threadSettings: { model: 'gpt-5.6-terra' },
      },
    });

    await runtime.readHistory(session);

    await expect(runtime.listDirectChildren(session)).resolves.toMatchObject([
      { id: 'child-1', model: 'gpt-5.6-terra' },
    ]);
  });

  it('recovers the resolved model when a historical direct child is not loaded', async () => {
    const resumed: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          if (method === 'initialize') return {};
          if (method === 'thread/resume') {
            const threadId = (params as { threadId: string }).threadId;
            resumed.push(threadId);
            return threadId === 'child-1' ? { model: 'gpt-5.6-terra' } : {};
          }
          if (method === 'thread/list')
            return {
              data: [{ id: 'child-1', status: { type: 'notLoaded' }, agentRole: 'worker' }],
            };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'historical-child-model',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');

    await expect(runtime.listDirectChildren(session)).resolves.toMatchObject([
      { id: 'child-1', model: 'gpt-5.6-terra' },
    ]);
    expect(resumed).toEqual(['root', 'child-1']);
  });

  it('recovers the resolved model for an active inherited-model child', async () => {
    const resumed: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          if (method === 'initialize') return {};
          if (method === 'thread/resume') {
            const threadId = (params as { threadId: string }).threadId;
            resumed.push(threadId);
            return threadId === 'child-1' ? { model: 'gpt-5.6-terra' } : {};
          }
          if (method === 'thread/list')
            return {
              data: [{ id: 'child-1', status: { type: 'active' }, agentRole: 'worker' }],
            };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'active-child-model',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');

    await expect(runtime.listDirectChildren(session)).resolves.toMatchObject([
      { id: 'child-1', status: 'active', model: 'gpt-5.6-terra' },
    ]);
    expect(resumed).toEqual(['root', 'child-1']);
  });

  it('lists direct children across bounded pages with models recovered from history', async () => {
    let page = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/resume' || method === 'initialize') return {};
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    items: [
                      {
                        id: 'spawn-1',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        model: 'gpt-5.6-luna',
                        receiverThreadIds: ['child-1'],
                      },
                    ],
                  },
                ],
              },
            };
          if (method === 'thread/list') {
            page += 1;
            return page === 1
              ? {
                  data: [
                    {
                      id: 'child-1',
                      status: { type: 'active' },
                      agentNickname: 'one',
                      agentRole: 'worker',
                      source: {
                        subagent: {
                          thread_spawn: { agent_path: '/root/l4_g2' },
                        },
                      },
                    },
                  ],
                  nextCursor: 'two',
                }
              : { data: [{ id: 'child-2', status: { type: 'idle' } }] };
          }
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'child-list',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await runtime.readHistory(session);
    await expect(runtime.listDirectChildren(session)).resolves.toMatchObject([
      {
        id: 'child-1',
        nickname: 'one',
        role: 'worker',
        model: 'gpt-5.6-luna',
        taskPath: '/root/l4_g2',
      },
      { id: 'child-2' },
    ]);
  });
  it('owns, observes, consumes, and exactly terminates a child background process', async () => {
    let active = true;
    const calls: Array<{ method: string; params: unknown }> = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'thread/resume' || method === 'initialize') return {};
          if (method === 'thread/backgroundTerminals/list')
            return active
              ? {
                  data: [
                    {
                      itemId: 'item-1',
                      processId: 'process-1',
                      command: 'opaque',
                      cwd: '/workspace',
                      osPid: 4242,
                      cpuPercent: 100,
                      rssKb: 13 * 1024 * 1024,
                    },
                  ],
                  nextCursor: null,
                }
              : { data: [], nextCursor: null };
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    items: [
                      {
                        id: 'item-1',
                        type: 'commandExecution',
                        processId: 'process-1',
                        status: 'completed',
                        exitCode: 0,
                        aggregatedOutput: 'must not enter lifecycle state',
                      },
                    ],
                  },
                ],
              },
            };
          if (method === 'thread/backgroundTerminals/terminate') return { terminated: true };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'processes',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');

    const observed = await runtime.inspectChildProcesses(session, {
      id: 'child-1',
      taskPath: '/root/l4',
    });
    expect(observed).toMatchObject([
      {
        processId: 'process-1',
        itemId: 'item-1',
        ownerThreadId: 'child-1',
        ownerTaskPath: '/root/l4',
        state: 'running',
        osPid: 4242,
        cpuPercent: 100,
        rssBytes: 13 * 1024 * 1024 * 1024,
      },
    ]);

    active = false;
    const exited = await runtime.inspectChildProcesses(session, {
      id: 'child-1',
      taskPath: '/root/l4',
    });
    expect(exited).toMatchObject([
      {
        processId: 'process-1',
        state: 'exited-awaiting-result',
        exitStatus: 0,
        resultArtifact: 'child-1:item-1',
      },
    ]);
    expect(JSON.stringify(exited)).not.toContain('must not enter lifecycle state');

    runtime.consumeChildProcessResult('processes', 'child-1', 'process-1');
    await expect(
      runtime.inspectChildProcesses(session, { id: 'child-1', taskPath: '/root/l4' }),
    ).resolves.toEqual([]);
    await expect(runtime.terminateChildProcess(session, 'child-1', 'process-1')).resolves.toBe(
      true,
    );
    expect(calls.at(-1)).toEqual({
      method: 'thread/backgroundTerminals/terminate',
      params: { threadId: 'child-1', processId: 'process-1' },
    });
  });
  it('fails closed on a looping child cursor', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/list' ? { data: [], nextCursor: 'loop' } : {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'loop',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).rejects.toThrow(
      'CODEX_CHILD_LIST_UNSUPPORTED',
    );
  });
  it('rejects missing thread and propagates child-list RPC failure', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/resume' || method === 'initialize') return {};
          throw new Error('RPC_DOWN');
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const base = {
      id: 'failure',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await expect(runtime.listDirectChildren({ ...base, threadId: null })).rejects.toThrow(
      'CODEX_THREAD_ID_MISSING',
    );
    await runtime.restore(base, 'after');
    await expect(runtime.listDirectChildren(base)).rejects.toThrow('RPC_DOWN');
  });
  it('fails closed when child pages exceed the 64-child bound', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/resume' || method === 'initialize'
            ? {}
            : {
                data: Array.from({ length: 64 }, (_, index) => ({ id: `c-${index}` })),
                nextCursor: 'more',
              },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'cap',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).rejects.toThrow(
      'CODEX_CHILD_LIST_UNSUPPORTED',
    );
  });
  it('fails closed after four child-list pages', async () => {
    let page = 0;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/resume' || method === 'initialize'
            ? {}
            : { data: [], nextCursor: `page-${++page}` },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'pages',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).rejects.toThrow(
      'CODEX_CHILD_LIST_UNSUPPORTED',
    );
  });
  it('ignores malformed and oversized child identifiers', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/resume' || method === 'initialize'
            ? {}
            : { data: [{ id: '' }, { id: 'x'.repeat(257) }, { id: 'valid' }] },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'malformed',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).resolves.toEqual([
      { id: 'valid', status: 'notLoaded', qualified: false },
    ]);
  });
  it('qualifies missing or future child statuses as disconnected evidence', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/resume' || method === 'initialize'
            ? {}
            : {
                data: [
                  { id: 'missing' },
                  { id: 'future', status: { type: 'futureStatus' } },
                  { id: 'idle', status: { type: 'idle' } },
                ],
              },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'status',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).resolves.toEqual([
      { id: 'missing', status: 'notLoaded', qualified: false },
      { id: 'future', status: 'notLoaded', qualified: false },
      { id: 'idle', status: 'idle' },
    ]);
  });
  it('stops on an oversized child cursor', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) =>
          method === 'thread/resume' || method === 'initialize'
            ? {}
            : { data: [], nextCursor: 'x'.repeat(257) },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const session = {
      id: 'cursor',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'root',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(session, 'after');
    await expect(runtime.listDirectChildren(session)).resolves.toEqual([]);
  });
  it('reuses an owned active runtime and resumes a stale ready row exactly once', async () => {
    const calls: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const base = {
      id: 's',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'thread-1',
      state: 'ready' as const,
      desiredState: 'active' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await runtime.restore(base, 'after');
    const active = await runtime.ensureWriter(
      { ...base, state: 'turnActive', activeTurnId: 'turn-1' },
      'later',
    );
    expect(active.session.state).toBe('turnActive');
    expect(calls).toEqual(['initialize', 'thread/resume']);

    const staleCalls: string[] = [];
    const stale = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          staleCalls.push(method);
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    await Promise.all([stale.ensureWriter(base, 'later'), stale.ensureWriter(base, 'later')]);
    expect(staleCalls).toEqual(['initialize', 'thread/resume']);
  });

  it('maps an active-writer startup conflict to writerBusy and disposes the child', async () => {
    const close = vi.fn();
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/resume')
            throw new CodexJsonRpcError(-32600, 'Thread thread-1 already has an active writer');
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close,
    }));
    const session = {
      id: 's',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'thread-1',
      state: 'stopped' as const,
      desiredState: 'stopped' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    await expect(runtime.ensureWriter(session, 'after')).rejects.toMatchObject({
      kind: 'writerBusy',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.ownsWriter('s')).toBe(false);
  });
  it('reads a stopped thread through a bounded detached reader without resume', async () => {
    const calls: string[] = [];
    const close = vi.fn();
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/read') return { thread: { turns: [] } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close,
    }));
    await expect(
      runtime.readHistory({
        id: 'stopped',
        workspaceId: 'workspace',
        workspacePath: '/missing-history-cwd',
        profile: 'default',
        threadId: 'thread-1',
        state: 'stopped',
        desiredState: 'stopped',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'before',
        updatedAt: 'before',
      }),
    ).resolves.toEqual({ turns: [], activeTurnId: null });
    expect(calls).toEqual(['initialize', 'thread/read']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a detached reader when initialization fails', async () => {
    const close = vi.fn();
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async () => {
          throw new Error('bad init');
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close,
    }));
    await expect(
      runtime.readHistory({
        id: 's',
        workspaceId: 'w',
        workspacePath: '/w',
        profile: 'default',
        threadId: 't',
        state: 'stopped',
        desiredState: 'stopped',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'a',
        updatedAt: 'a',
      }),
    ).rejects.toThrow('bad init');
    expect(close).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent detached reads and cleans up malformed results', async () => {
    let launches = 0;
    const close = vi.fn();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const runtime = new CodexSessionRuntime(() => {
      launches += 1;
      return {
        rpc: {
          request: async (method) => {
            if (method === 'thread/read') {
              await waiting;
              return { malformed: true };
            }
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close,
      };
    });
    const session = {
      id: 's',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      threadId: 't',
      state: 'stopped' as const,
      desiredState: 'stopped' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'a',
      updatedAt: 'a',
    };
    const first = runtime.readHistory(session);
    const second = runtime.readHistory(session);
    release();
    await expect(Promise.all([first, second])).rejects.toThrow();
    expect(launches).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    await expect(runtime.readHistory({ ...session, threadId: null })).rejects.toThrow(
      'CODEX_THREAD_ID_MISSING',
    );
    expect(launches).toBe(1);
  });

  it('uses an owned runtime for history without launching a temporary reader', async () => {
    const launches = vi.fn(() => ({
      rpc: {
        request: async (method: string) =>
          method === 'thread/start' ? { thread: { id: 't' } } : { thread: { turns: [] } },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const runtime = new CodexSessionRuntime(launches);
    const ready = await runtime.start(
      {
        id: 's',
        workspaceId: 'w',
        workspacePath: '/w',
        profile: 'default',
        threadId: null,
        state: 'starting',
        desiredState: 'active',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'a',
        updatedAt: 'a',
      },
      'b',
    );
    await runtime.readHistory(ready);
    expect(launches).toHaveBeenCalledTimes(1);
  });

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

  it('preserves each durable workspace across new and resumed runtime launches', async () => {
    const launches: Array<{ cwd: string }> = [];
    let thread = 0;
    const runtime = new CodexSessionRuntime((input) => {
      launches.push({ cwd: input.cwd });
      return {
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: `thread-${++thread}` } } : {},
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {},
      };
    });
    const base = {
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
    const first = await runtime.start(
      { ...base, id: 'first', workspaceId: 'one', workspacePath: '/tmp/workspace one' },
      'after',
    );
    await runtime.start(
      { ...base, id: 'second', workspaceId: 'two', workspacePath: '/tmp/workspace two' },
      'after',
    );
    runtime.stop(first.id);
    await runtime.ensureWriter(first, 'later');

    expect(launches).toEqual([
      { cwd: '/tmp/workspace one' },
      { cwd: '/tmp/workspace two' },
      { cwd: '/tmp/workspace one' },
    ]);
  });

  it('writes each live-plan-derived thread name once and ignores metadata failures', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params });
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
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
    );
    const plan = {
      title: 'Roadmap',
      totalSteps: 1,
      doneSteps: 0,
      allDone: false,
      currentStepId: 'l1',
      steps: [
        {
          id: 'l1',
          title: 'Ship',
          level: 1 as const,
          state: 'WIP' as const,
          priority: 'A' as const,
          reviewStatus: 'UNREVIEWED' as const,
          description: {},
          children: [],
        },
      ],
    };
    await runtime.syncThreadPlanName('session-1', plan);
    await runtime.syncThreadPlanName('session-1', plan);
    expect(calls.filter((call) => call.method === 'thread/name/set')).toEqual([
      { method: 'thread/name/set', params: { threadId: 'thread-1', name: 'Roadmap — L1 1/1' } },
    ]);
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

  it('passes the durable Codex settings through to thread start', async () => {
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
        model: 'gpt-5.4',
        executionPolicy: { sandbox: 'workspace-write', approvalPolicy: 'never' },
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

    expect(threadStartParams).toEqual({
      cwd: '/workspace',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      dynamicTools: [gestaltQuizDynamicTool, gestaltOrgPlanAttentionDynamicTool],
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

  it('does not recover when an exit callback arrives during explicit relay shutdown', async () => {
    const exits: Array<() => void> = [];
    let launched = 0;
    const exited = vi.fn();
    const runtime = new CodexSessionRuntime(
      () => {
        const index = launched++;
        return {
          rpc: {
            request: async (method) =>
              method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {
            if (index === 0) exits[1]?.();
          },
          onExit: (listener) => {
            exits[index] = listener;
            return () => {};
          },
        };
      },
      undefined,
      undefined,
      undefined,
      exited,
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
    await runtime.start(
      {
        id: 'session-2',
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
    runtime.stopAll();
    expect(exited).not.toHaveBeenCalled();
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

  it('does not report an explicit release as an unexpected process exit', async () => {
    let exit: (() => void) | undefined;
    let releaseUnsubscribe: (() => void) | undefined;
    const exited = vi.fn();
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) => {
            if (method === 'thread/start') return { thread: { id: 'thread-1' } };
            if (method === 'thread/unsubscribe')
              return await new Promise((resolve) => {
                releaseUnsubscribe = () => resolve({});
              });
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {},
        onExit: (listener) => {
          exit = listener;
          return () => {};
        },
      }),
      undefined,
      undefined,
      undefined,
      exited,
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
    const releasing = runtime.release('session-1');
    await vi.waitFor(() => expect(releaseUnsubscribe).toBeTypeOf('function'));
    exit?.();
    releaseUnsubscribe?.();
    await releasing;
    expect(exited).not.toHaveBeenCalled();
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

  it('derives start, resume, and writer reacquisition overrides from the durable policy', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params });
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const policy = { sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const };
    const starting = {
      id: 'policy-session',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      model: 'gpt-5.4',
      executionPolicy: policy,
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
    const started = await runtime.start(starting, 'after');
    runtime.stop(starting.id);
    await runtime.ensureWriter(started, 'later');
    const writerCalls = calls.filter(
      (call) => call.method === 'thread/start' || call.method === 'thread/resume',
    );
    expect(writerCalls).toEqual([
      expect.objectContaining({
        method: 'thread/start',
        params: expect.objectContaining({ model: 'gpt-5.4', ...policy }),
      }),
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ ...policy }),
      }),
    ]);
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
          id: 'session-1',
          workspaceId: 'workspace-1',
          workspacePath: '/workspace',
          profile: 'default',
          model: 'gpt-5.4',
          executionPolicy: { sandbox: 'workspace-write', approvalPolicy: 'untrusted' },
          threadId: 'old-thread',
          state,
          desiredState: 'stopped',
          activeTurnId: null,
          protocolVersion: null,
          failureCount: 0,
          pendingInteractions: [],
          createdAt: 'before',
          updatedAt: 'before',
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
      expect(calls.map((call) => call.method)).toEqual([
        'initialize',
        'thread/resume',
        'thread/start',
      ]);
      expect(calls.at(-1)?.params).toEqual({
        cwd: '/workspace',
        approvalPolicy: 'untrusted',
        model: 'gpt-5.4',
        sandbox: 'workspace-write',
        dynamicTools: [gestaltQuizDynamicTool, gestaltOrgPlanAttentionDynamicTool],
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
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {
        closed += 1;
      },
    }));
    const original = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      threadId: 'old-thread',
      state: 'released' as const,
      desiredState: 'stopped' as const,
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 'before',
      updatedAt: 'before',
    };

    await expect(runtime.restoreWithOutcome(original, 'after')).rejects.toThrow(
      'invalid parameters',
    );
    expect(calls).toEqual(['initialize', 'thread/resume']);
    expect(closed).toBe(1);
    expect(original.threadId).toBe('old-thread');
  });

  it('cleans a failed replacement child and its status lease', async () => {
    const closed: string[] = [];
    const source: PlanStatusSource = {
      open: async () => ({
        statusDirectory: '/private/session-1',
        close: () => closed.push('lease'),
        remove: async () => {},
      }),
      remove: async () => {},
      closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) => {
            if (method === 'thread/resume')
              throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
            if (method === 'thread/start') throw new Error('replacement failed');
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => closed.push('process'),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source,
    );
    await expect(
      runtime.restoreWithOutcome(
        {
          id: 'session-1',
          workspaceId: 'workspace-1',
          workspacePath: '/workspace',
          profile: 'default',
          threadId: 'old-thread',
          state: 'attentionRequired',
          desiredState: 'stopped',
          activeTurnId: null,
          protocolVersion: null,
          failureCount: 0,
          pendingInteractions: [],
          createdAt: 'before',
          updatedAt: 'before',
        },
        'after',
      ),
    ).rejects.toThrow('replacement failed');
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
        return {
          statusDirectory: `/private/${session.id}.json`,
          close: () => {},
          remove: async () => {},
        };
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
                {
                  label: 'Supervised multi-agent',
                  description: 'A supervisor coordinates agents.',
                },
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
    const response = toQuizToolResponse([
      { id: 'execution_mode', answer: 'Supervised multi-agent' },
    ]);
    expect(runtime.attentionWriterState('missing-session', '7')).toBe('unavailable');
    expect(runtime.attentionWriterState('session-1', '7')).toBe('available');
    expect(runtime.resolveServerRequest('session-1', '7', response)).toBe(true);
    expect(runtime.attentionWriterState('session-1', '7')).toBe('cleared');
    expect(runtime.resolveServerRequest('session-1', '7', response)).toBe(false);
    await expect(result).resolves.toEqual(response);
  });

  it('registers a quiz response resolver before publishing the interaction', async () => {
    let requestListener:
      ((value: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    const response = toQuizToolResponse([{ id: 'execution_mode', answer: 'Solo' }]);
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
        expect(runtime.resolveServerRequest(sessionId, String(request.id), response)).toBe(true);
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

    await expect(
      requestListener!({
        id: 8,
        method: 'item/tool/call',
        params: { tool: GESTALT_QUIZ_TOOL_NAME, arguments: { questions: [] } },
      }),
    ).resolves.toEqual(response);
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
          id: 'terminal-turn-1',
          items: [{ id: 'message-1', type: 'agentMessage' }],
          startedAt: 1_784_102_400,
          completedAt: null,
        },
      ],
      activeTurnId: 'terminal-turn-1',
    });
  });

  it('sends the client operation identifier as clientUserMessageId', async () => {
    let turnStartParams: unknown;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'turn/start') {
            turnStartParams = params;
            return { turn: { id: 'turn-1' } };
          }
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

    await runtime.startTurn(ready, 'hello', 'operation-1', 'later');
    expect(turnStartParams).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      clientUserMessageId: 'operation-1',
    });
  });

  it('queues active-turn input through turn steering with an exact turn precondition', async () => {
    let steerParams: unknown;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, params) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'turn/steer') steerParams = params;
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

    await runtime.queueTurnInput(ready, 'turn-1', 'focus on tests', 'message-1');
    expect(steerParams).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'focus on tests', text_elements: [] }],
      clientUserMessageId: 'message-1',
    });
  });

  it('preserves bounded canonical user messages and client identifiers from thread history', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    id: 'turn-1',
                    items: [
                      {
                        id: 'user-1',
                        type: 'userMessage',
                        clientId: 'operation-1',
                        content: [{ type: 'text', text: 'prompt 1' }, { type: 'image' }],
                      },
                      { id: 'agent-1', type: 'agentMessage', text: 'answer 1' },
                    ],
                  },
                  {
                    id: 'turn-2',
                    items: [
                      {
                        id: 'user-2',
                        type: 'userMessage',
                        clientId: 'x'.repeat(257),
                        content: [
                          { type: 'text', text: 'prompt 2' },
                          { type: 'text', text: 'x'.repeat(64_001) },
                        ],
                      },
                      { id: 'agent-2', type: 'agentMessage', text: 'answer 2' },
                      { id: 'invalid', type: 'userMessage', content: [{ type: 'image' }] },
                    ],
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

    await expect(runtime.readHistory(ready)).resolves.toMatchObject({
      turns: [
        {
          id: 'turn-1',
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              clientId: 'operation-1',
              content: [{ type: 'text', text: 'prompt 1' }],
            },
            { id: 'agent-1', type: 'agentMessage', text: 'answer 1' },
          ],
        },
        {
          id: 'turn-2',
          items: [
            { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'prompt 2' }] },
            { id: 'agent-2', type: 'agentMessage', text: 'answer 2' },
          ],
        },
      ],
    });
  });

  it('decodes every activity type rendered by canonical history and ignores unknown items', async () => {
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/start') return { thread: { id: 'thread-1' } };
          if (method === 'thread/read')
            return {
              thread: {
                turns: [
                  {
                    id: 'turn-1',
                    items: [
                      {
                        id: 'reasoning',
                        type: 'reasoning',
                        summary: ['checked', { type: 'summary_text', text: 'files' }],
                      },
                      { id: 'plan', type: 'plan', text: '1. inspect' },
                      {
                        id: 'command',
                        type: 'commandExecution',
                        command: 'git status',
                        status: 'completed',
                        exitCode: 0,
                      },
                      {
                        id: 'files',
                        type: 'fileChange',
                        status: 'completed',
                        changes: [
                          {
                            path: 'C:\\repo\\file.ts',
                            diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more',
                          },
                        ],
                      },
                      {
                        id: 'mcp',
                        type: 'mcpToolCall',
                        tool: 'filesystem.read_file',
                        status: 'completed',
                      },
                      {
                        id: 'dynamic',
                        type: 'dynamicToolCall',
                        tool: 'lookup_ticket',
                        status: 'failed',
                      },
                      { id: 'unknown', type: 'imageView', path: '/private' },
                    ],
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

    await expect(runtime.readHistory(ready)).resolves.toMatchObject({
      turns: [
        {
          id: 'turn-1',
          items: [
            { id: 'reasoning', type: 'reasoning', summary: ['checked', 'files'] },
            { id: 'plan', type: 'plan', text: '1. inspect' },
            {
              id: 'command',
              type: 'commandExecution',
              command: 'git status',
              status: 'completed',
              exitCode: 0,
            },
            {
              id: 'files',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'C:\\repo\\file.ts', additions: 2, deletions: 1 }],
            },
            { id: 'mcp', type: 'mcpToolCall', tool: 'filesystem.read_file', status: 'completed' },
            { id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup_ticket', status: 'failed' },
          ],
        },
      ],
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

  it('fails acquisition when the process exits while its resource is initialized', async () => {
    const exited: string[] = [];
    let exitUnsubscribed = 0;
    let notificationsRegistered = 0;
    let requestsRegistered = 0;
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => {
            notificationsRegistered += 1;
            return () => {};
          },
          onServerRequest: () => {
            requestsRegistered += 1;
            return () => {};
          },
        },
        close: () => {},
        onExit: (listener) => {
          listener();
          return () => {
            exitUnsubscribed += 1;
          };
        },
      }),
      undefined,
      undefined,
      undefined,
      (id) => exited.push(id),
    );
    await expect(
      runtime.start(
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
      ),
    ).rejects.toThrow('CODEX_SESSION_PROCESS_EXITED');
    expect(exited).toEqual(['session-1']);
    expect(exitUnsubscribed).toBe(1);
    expect(notificationsRegistered).toBe(0);
    expect(requestsRegistered).toBe(0);
    expect(runtime.ownsWriter('session-1')).toBe(false);
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

  it('bounds server requests without timing out explicit user input', async () => {
    vi.useFakeTimers();
    let requestListener:
      ((request: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    const accepted = vi.fn(() => true);
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
      accepted,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      10,
      1,
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
    const pending = requestListener!({ id: 1, method: 'item/tool/call', params: {} });
    await expect(requestListener!({ id: 2, method: 'item/tool/call', params: {} })).rejects.toThrow(
      'CODEX_SERVER_REQUEST_LIMIT',
    );
    expect(accepted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(runtime.resolveServerRequest('session-1', '1', { answers: {} })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: {} });
    vi.useRealTimers();
  });

  it('settles a local request when app-server reports that it was cleared', async () => {
    let requestListener:
      ((request: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
    let notificationListener:
      ((notification: { method: string; params: unknown }) => void) | undefined;
    const notified = vi.fn();
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: (listener) => {
            notificationListener = listener;
            return () => {};
          },
          onServerRequest: (listener) => {
            requestListener = listener;
            return () => {};
          },
        },
        close: () => {},
      }),
      undefined,
      notified,
      () => true,
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
    const pending = requestListener!({
      id: 3,
      method: 'item/tool/requestUserInput',
      params: { isBlocking: true, questions: [] },
    });
    const cleared = pending.catch((error: unknown) => error);
    notificationListener!({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 3 },
    });
    expect(await cleared).toEqual(
      expect.objectContaining({ message: 'CODEX_SERVER_REQUEST_CLEARED' }),
    );
    expect(runtime.resolveServerRequest('session-1', '3', {})).toBe(false);
    expect(notified).toHaveBeenCalledWith(
      'session-1',
      { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 3 } },
      expect.objectContaining({ kind: 'root', physicalThreadId: 'thread-1' }),
    );
  });

  it('removes listeners and leases exactly once when exit races release', async () => {
    let exit: (() => void) | undefined;
    let listeners = 0;
    let leases = 0;
    const source: PlanStatusSource = {
      open: async () => ({
        statusDirectory: '/private/session-1',
        close: () => {
          leases += 1;
        },
        remove: async () => {},
      }),
      remove: async () => {},
      closeAll: () => {},
    };
    const runtime = new CodexSessionRuntime(
      () => ({
        rpc: {
          request: async (method) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => {
            listeners += 1;
            return () => {
              listeners -= 1;
            };
          },
          onServerRequest: () => {
            listeners += 1;
            return () => {
              listeners -= 1;
            };
          },
        },
        close: () => {},
        onExit: (listener) => {
          exit = listener;
          listeners += 1;
          return () => {
            listeners -= 1;
          };
        },
      }),
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
          if (method === 'thread/name/set') {
            nameCalls += 1;
            throw new CodexJsonRpcError(-32601, 'method not found');
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
    );
    const plan = {
      title: 'Plan',
      totalSteps: 1,
      doneSteps: 0,
      allDone: false,
      currentStepId: 'l1',
      steps: [
        {
          id: 'l1',
          title: 'Ship',
          level: 1 as const,
          state: 'WIP' as const,
          priority: 'A' as const,
          reviewStatus: 'UNREVIEWED' as const,
          description: {},
          children: [],
        },
      ],
    };
    await runtime.syncThreadPlanName('session-1', plan);
    await runtime.syncThreadPlanName('session-1', plan);
    expect(nameCalls).toBe(1);
  });
});
