/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { KimiWebError } from './kimi-errors.js';
import { KimiSessionRuntime } from './kimi-session-runtime.js';
import type { KimiServerHandle, KimiWebServerManager } from './kimi-web-server-manager.js';
import type { KimiWsClient, KimiWsEvent } from './kimi-ws-client.js';

const NOW = '2026-09-22T00:00:00.000Z';

function snapshot(threadId: string | null = null) {
  const created = RelaySession.create({
    id: 'relay-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    provider: 'kimi',
    profile: 'default',
    model: 'k1',
    effectiveSkillSelection: { skills: [] },
    now: NOW,
  }).snapshot;
  return threadId ? { ...created, threadId } : created;
}

type RecordedCall = { method: 'post' | 'get'; path: string; body?: unknown };

/** Recording REST client whose GET routes may be replaced per test. */
function fakeRest(
  getRoutes: Map<string, () => unknown>,
  onPost?: (path: string, body: unknown) => unknown | Promise<unknown>,
) {
  const calls: RecordedCall[] = [];
  let nextThread = 1;
  const client = {
    calls,
    async post(path: string, body?: unknown) {
      calls.push({ method: 'post', path, body });
      if (onPost) {
        const result = await onPost(path, body);
        if (result !== undefined) return result;
      }
      if (path === '/api/v1/sessions') return { id: `kimi-thread-${nextThread++}` };
      return {};
    },
    async get(path: string) {
      calls.push({ method: 'get', path });
      const route = getRoutes.get(path);
      if (!route) throw new KimiWebError(404, `no route ${path}`);
      return route();
    },
  };
  return client;
}

/** Capturing websocket client; tests drive events through `emit`. */
function fakeWs() {
  const eventListeners = new Set<(event: KimiWsEvent) => void>();
  const closeListeners = new Set<() => void>();
  const client = {
    connect: async () => {},
    onEvent: (listener: (event: KimiWsEvent) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onClose: (listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    subscribe: async () => ({ type: 'ack', code: 0 }),
    unsubscribe: async () => ({ type: 'ack', code: 0 }),
    abort: async () => ({ type: 'ack', code: 0 }),
    close: () => {},
  } as unknown as KimiWsClient;
  return {
    client,
    emit: (event: KimiWsEvent) => {
      for (const listener of eventListeners) listener(event);
    },
    close: () => {
      for (const listener of closeListeners) listener();
    },
  };
}

type Harness = {
  runtime: KimiSessionRuntime;
  rest: ReturnType<typeof fakeRest>;
  ws: ReturnType<typeof fakeWs>;
  notifications: KimiWsEvent[];
  requests: Array<{ id: number; method: string; params: unknown }>;
  exits: string[];
};

function harness(
  getRoutes = new Map<string, () => unknown>(),
  options: {
    profileKey?: string;
    onPost?: (path: string, body: unknown) => unknown | Promise<unknown>;
  } = {},
): Harness {
  const ws = fakeWs();
  const rest = fakeRest(getRoutes, options.onPost);
  const notifications: KimiWsEvent[] = [];
  const requests: Harness['requests'] = [];
  const exits: string[] = [];
  const handle = {
    profileKey: options.profileKey ?? 'default',
    baseUrl: 'http://127.0.0.1:9',
    token: 'token',
    shareDir: '/tmp/share',
    skillsDir: '/tmp/share/skills',
    client: rest,
  } as unknown as KimiServerHandle;
  const servers = {
    ensure: async () => handle,
    get: (profileKey: string) => (profileKey === handle.profileKey ? handle : null),
  } as unknown as KimiWebServerManager;
  const runtime = new KimiSessionRuntime({
    servers,
    skillsFor: async () => [],
    onNotification: (_sessionId, event) => notifications.push(event),
    onServerRequest: (_sessionId, request) => {
      requests.push(request);
      return true;
    },
    onExit: (sessionId) => exits.push(sessionId),
    wsClientFor: () => ws.client,
  });
  return { runtime, rest, ws, notifications, requests, exits };
}

const thread1Routes = () =>
  new Map<string, () => unknown>([
    [
      '/api/v1/sessions/kimi-thread-1',
      () => ({ main_turn_active: false, current_prompt_id: null }),
    ],
    ['/api/v1/sessions/kimi-thread-1/messages', () => ({ items: [] })],
    ['/api/v1/sessions/kimi-thread-1/approvals', () => ({ items: [] })],
    ['/api/v1/sessions/kimi-thread-1/questions', () => ({ items: [] })],
  ]);

describe('KimiSessionRuntime', () => {
  it('starts a session through the manager and binds the kimi thread', async () => {
    const { runtime, rest } = harness();
    const started = await runtime.start(snapshot(), NOW);
    expect(started.threadId).toBe('kimi-thread-1');
    expect(started.state).toBe('ready');
    expect(rest.calls[0]).toEqual({
      method: 'post',
      path: '/api/v1/sessions',
      body: { metadata: { cwd: '/repo' } },
    });
    expect(rest.calls[1]).toMatchObject({
      method: 'post',
      path: '/api/v1/sessions/kimi-thread-1/profile',
    });
    expect((rest.calls[1].body as { agent_config: object }).agent_config).toMatchObject({
      model: 'k1',
      permission_mode: 'manual',
    });
    expect(runtime.ownsWriter('relay-1')).toBe(true);
  });

  it('maps an approval policy of never to the yolo permission mode', async () => {
    const { runtime, rest } = harness();
    const snap = {
      ...snapshot(),
      executionPolicy: { approvalPolicy: 'never' },
    } as never;
    await runtime.start(snap, NOW);
    expect((rest.calls[1].body as { agent_config: object }).agent_config).toMatchObject({
      permission_mode: 'yolo',
    });
  });

  it('submits turns as prompts and binds turn numbers to prompt ids in order', async () => {
    const { runtime, rest, ws } = harness();
    const started = await runtime.start(snapshot(), NOW);
    const first = await runtime.startTurn(started, 'hello', 'prompt-a', NOW);
    expect(first.activeTurnId).toBe('prompt-a');
    expect(rest.calls.at(-1)).toMatchObject({
      method: 'post',
      path: '/api/v1/sessions/kimi-thread-1/prompts',
    });
    expect(rest.calls.at(-1)?.body).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      prompt_id: 'prompt-a',
      model: 'k1',
    });
    // kimi queues follow-ups server-side: steering submits the second prompt
    // while the first turn is still active.
    await runtime.queueTurnInput(first, 'prompt-a', 'again', 'prompt-b');
    // kimi turn numbers resolve back to the gestalt prompt ids, FIFO.
    ws.emit({
      type: 'turn.started',
      seq: 1,
      session_id: 'kimi-thread-1',
      payload: { type: 'turn.started', agentId: 'a1', turnId: 1 },
    });
    ws.emit({
      type: 'turn.started',
      seq: 2,
      session_id: 'kimi-thread-1',
      payload: { type: 'turn.started', agentId: 'a1', turnId: 2 },
    });
    expect(runtime.eventContext('relay-1').resolveTurnId('a1', 1)).toBe('prompt-a');
    expect(runtime.eventContext('relay-1').resolveTurnId('a1', 2)).toBe('prompt-b');
    // Child agents never consume main-agent prompt bindings.
    ws.emit({
      type: 'turn.started',
      seq: 3,
      session_id: 'kimi-thread-1',
      payload: { type: 'turn.started', agentId: 'child-1', turnId: 1 },
    });
    expect(runtime.eventContext('relay-1').isChildAgent('child-1')).toBe(true);
    expect(runtime.eventContext('relay-1').resolveTurnId('a1', 3)).toBeNull();
  });

  it('correlates the main prompt before a turn-started event races the REST response', async () => {
    const wsRef: { current?: ReturnType<typeof fakeWs> } = {};
    const fixture = harness(new Map(), {
      onPost: (path) => {
        if (path === '/api/v1/sessions') return { id: 'kimi-thread-1' };
        if (path.endsWith('/prompts'))
          wsRef.current?.emit({
            type: 'turn.started',
            seq: 1,
            session_id: 'kimi-thread-1',
            payload: { type: 'turn.started', agentId: 'main-agent', turnId: 1 },
          });
        return {};
      },
    });
    wsRef.current = fixture.ws;
    const started = await fixture.runtime.start(snapshot(), NOW);

    await fixture.runtime.startTurn(started, 'hello', 'prompt-race', NOW);

    expect(fixture.runtime.eventContext('relay-1').isChildAgent('main-agent')).toBe(false);
    expect(fixture.runtime.eventContext('relay-1').resolveTurnId('main-agent', 1)).toBe(
      'prompt-race',
    );
  });

  it('rolls back prompt correlation when submission fails after a raced event', async () => {
    const wsRef: { current?: ReturnType<typeof fakeWs> } = {};
    const fixture = harness(new Map(), {
      onPost: (path) => {
        if (path === '/api/v1/sessions') return { id: 'kimi-thread-1' };
        if (path.endsWith('/prompts')) {
          wsRef.current?.emit({
            type: 'turn.started',
            seq: 1,
            session_id: 'kimi-thread-1',
            payload: { type: 'turn.started', agentId: 'main-agent', turnId: 1 },
          });
          throw new Error('submission failed');
        }
        return {};
      },
    });
    wsRef.current = fixture.ws;
    const started = await fixture.runtime.start(snapshot(), NOW);

    await expect(fixture.runtime.startTurn(started, 'hello', 'prompt-failed', NOW)).rejects.toThrow(
      'submission failed',
    );

    expect(fixture.runtime.eventContext('relay-1').resolveTurnId('main-agent', 1)).toBeNull();
  });

  it('queues steering input as another prompt while a turn runs', async () => {
    const { runtime, rest } = harness();
    const started = await runtime.start(snapshot(), NOW);
    const active = await runtime.startTurn(started, 'hello', 'prompt-a', NOW);
    await runtime.queueTurnInput(active, 'prompt-a', 'wait, also this', 'prompt-b');
    expect(rest.calls.at(-1)?.body).toMatchObject({
      content: [{ type: 'text', text: 'wait, also this' }],
      prompt_id: 'prompt-b',
    });
  });

  it('steers queued input into the active turn once kimi binds it', async () => {
    const { runtime, rest, ws } = harness();
    const started = await runtime.start(snapshot(), NOW);
    const active = await runtime.startTurn(started, 'hello', 'prompt-a', NOW);
    ws.emit({
      type: 'turn.started',
      seq: 1,
      session_id: 'kimi-thread-1',
      payload: { type: 'turn.started', agentId: 'a1', turnId: 1 },
    });
    await runtime.queueTurnInput(active, 'prompt-a', 'wait, also this', 'prompt-b');
    expect(rest.calls.at(-1)).toEqual({
      method: 'post',
      path: '/api/v1/sessions/kimi-thread-1/prompts:steer',
      body: { prompt_ids: ['prompt-b'] },
    });
    // Completion clears the active prompt: the next submit is a plain
    // enqueue with no steer call.
    ws.emit({
      type: 'prompt.completed',
      seq: 2,
      session_id: 'kimi-thread-1',
      payload: { type: 'prompt.completed', agentId: 'a1', promptId: 'prompt-a' },
    });
    await runtime.queueTurnInput(active, 'prompt-a', 'next', 'prompt-c');
    expect(rest.calls.at(-1)).toMatchObject({
      method: 'post',
      path: '/api/v1/sessions/kimi-thread-1/prompts',
    });
    expect(rest.calls.at(-1)?.body).toMatchObject({ prompt_id: 'prompt-c' });
  });

  it('interrupts a turn through the abort endpoint', async () => {
    const { runtime, rest } = harness();
    const started = await runtime.start(snapshot(), NOW);
    await runtime.interruptTurn(started, 'prompt-a');
    expect(rest.calls.at(-1)).toMatchObject({
      method: 'post',
      path: '/api/v1/sessions/kimi-thread-1/prompts/prompt-a:abort',
    });
  });

  it('groups the kimi transcript into relay turns with an active prompt', async () => {
    const routes = thread1Routes();
    routes.set('/api/v1/sessions/kimi-thread-1', () => ({
      main_turn_active: true,
      current_prompt_id: 'prompt-9',
    }));
    routes.set('/api/v1/sessions/kimi-thread-1/messages', () => ({
      items: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
        {
          id: 'm3',
          role: 'tool',
          content: [{ type: 'tool_use', tool_call_id: 'tc1', tool_name: 'read_file' }],
        },
        { id: 'm4', role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    }));
    const { runtime } = harness(routes);
    const history = await runtime.readHistory(snapshot('kimi-thread-1'));
    expect(history.activeTurnId).toBe('prompt-9');
    expect(history.turns).toHaveLength(2);
    expect(history.turns[0].items.map((item) => item.kind)).toEqual(['user', 'agent', 'tool']);
    expect(history.turns[1].items.map((item) => item.kind)).toEqual(['user']);
  });

  it('restores a missing thread by binding a replacement', async () => {
    const routes = new Map<string, () => unknown>([
      [
        '/api/v1/sessions/gone-thread',
        () => {
          throw new KimiWebError(40401, 'session not found');
        },
      ],
    ]);
    const { runtime } = harness(routes);
    const result = await runtime.restoreWithOutcome(snapshot('gone-thread'), NOW);
    expect(result.replacementCreated).toBe(true);
    expect(result.historyUnavailable).toBe(true);
    expect(result.session.threadId).toBe('kimi-thread-1');
  });

  it('polls approvals on the awaiting status and resolves decisions', async () => {
    const routes = thread1Routes();
    routes.set('/api/v1/sessions/kimi-thread-1/approvals', () => ({
      items: [
        {
          approval_id: 'ap-1',
          tool_name: 'shell_command',
          action: 'list files',
          tool_input_display: { command: 'ls' },
        },
      ],
    }));
    const { runtime, rest, ws, requests } = harness(routes);
    await runtime.start(snapshot(), NOW);
    ws.emit({
      type: 'agent.status.updated',
      seq: 1,
      session_id: 'kimi-thread-1',
      payload: { type: 'agent.status.updated', agentId: 'a1', status: 'awaiting_approval' },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].method).toBe('item/commandExecution/requestApproval');
    expect(await runtime.resolveServerRequest('relay-1', String(requests[0].id), 'accept')).toBe(
      true,
    );
    expect(
      rest.calls.some(
        (call) =>
          call.method === 'post' &&
          call.path === '/api/v1/sessions/kimi-thread-1/approvals/ap-1' &&
          (call.body as { decision: string }).decision === 'approved',
      ),
    ).toBe(true);
  });

  it('keeps a failed provider interaction retryable until Kimi accepts it', async () => {
    const routes = thread1Routes();
    routes.set('/api/v1/sessions/kimi-thread-1/approvals', () => ({
      items: [
        {
          approval_id: 'ap-retry',
          tool_name: 'shell_command',
          action: 'list files',
          tool_input_display: { command: 'ls' },
        },
      ],
    }));
    let failures = 1;
    const fixture = harness(routes, {
      onPost: (path) => {
        if (path === '/api/v1/sessions') return { id: 'kimi-thread-1' };
        if (path.endsWith('/approvals/ap-retry') && failures-- > 0)
          throw new Error('provider unavailable');
        return {};
      },
    });
    await fixture.runtime.start(snapshot(), NOW);
    fixture.ws.emit({
      type: 'agent.status.updated',
      seq: 1,
      session_id: 'kimi-thread-1',
      payload: { type: 'agent.status.updated', agentId: 'a1', status: 'awaiting_approval' },
    });
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    const requestId = String(fixture.requests[0].id);

    expect(await fixture.runtime.resolveServerRequest('relay-1', requestId, 'accept')).toBe(false);
    expect(await fixture.runtime.resolveServerRequest('relay-1', requestId, 'accept')).toBe(true);
  });

  it('reads an imported recent thread from its non-default owning profile server', async () => {
    const routes = new Map<string, () => unknown>([
      ['/api/v1/sessions/recent-thread/messages', () => ({ items: [] })],
      [
        '/api/v1/sessions/recent-thread',
        () => ({ main_turn_active: false, current_prompt_id: null }),
      ],
    ]);
    const { runtime } = harness(routes, { profileKey: 'focused' });
    const imported = {
      ...snapshot('recent-thread'),
      profile: 'focused',
      effectiveSkillSelection: undefined,
    };

    await expect(runtime.readHistory(imported)).resolves.toEqual({
      turns: [],
      activeTurnId: null,
    });
  });

  it('reports exits when the profile websocket closes', async () => {
    const { runtime, ws, exits } = harness();
    await runtime.start(snapshot(), NOW);
    ws.close();
    expect(exits).toEqual(['relay-1']);
    expect(runtime.ownsWriter('relay-1')).toBe(false);
    await runtime.release('relay-1');
  });

  it('keeps codex-only surfaces inert', async () => {
    const { runtime } = harness();
    expect(await runtime.authorizePlanMeasurement()).toBe(false);
    expect(await runtime.listDirectChildren()).toEqual([]);
    expect(await runtime.inspectChildProcesses()).toEqual([]);
    await expect(runtime.startExecutorTurn()).rejects.toThrow('KIMI_UNSUPPORTED');
  });
});
