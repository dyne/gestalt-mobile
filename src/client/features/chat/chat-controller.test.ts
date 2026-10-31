/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatController, decodeChatSnapshot, type ChatViewState } from './chat-controller.js';
import { efficiencyFixture } from '../../../shared/contracts/tool-efficiency.test-fixture.js';
import { AgentActivityController } from '../agent-activity/agent-activity-controller.js';

class Socket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

it('rejects malformed autopilot audit arrays and accepts a failed attention settlement', () => {
  const base = {
    items: [],
    turns: [],
    activeTurnId: null,
    interactions: [
      {
        requestId: 'attention',
        kind: 'orgPlanAttention',
        turnId: null,
        requestedAt: '2026-08-20T00:00:00.000Z',
        resolvedAt: '2026-08-20T00:01:00.000Z',
        outcome: 'failed',
      },
    ],
    baseSequence: 1,
  };
  expect(
    decodeChatSnapshot({
      ...base,
      autopilotAudit: [{ id: 'audit', label: 'safe', occurredAt: 1 }],
    }),
  ).not.toBeNull();
  expect(
    decodeChatSnapshot({
      ...base,
      autopilotAudit: [{ id: 'audit', label: 'safe', occurredAt: 'wrong' }],
    }),
  ).toBeNull();
});
it('accepts only safe activity snapshots', () => {
  const base = {
    items: [],
    turns: [],
    activeTurnId: null,
    interactions: [],
    baseSequence: 1,
  };
  expect(
    decodeChatSnapshot({
      ...base,
      activities: [
        {
          id: 'command-1',
          label: 'Command · completed',
          detail: 'npm test',
          turnId: 'turn-1',
          occurredAt: 1,
        },
      ],
    }),
  ).not.toBeNull();
  expect(
    decodeChatSnapshot({
      ...base,
      activities: [{ id: 'command-1', label: 'Command', detail: 'npm test', occurredAt: 'wrong' }],
    }),
  ).toBeNull();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  return { promise, resolve, reject };
};
const environment = () => ({
  location: { protocol: 'http:', host: 'relay.test' } as Location,
  document: {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Document,
  window: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Window,
});
describe('ChatController', () => {
  it.each([null, 'turn'])(
    'keeps normal background refreshes quiet with active turn %j',
    async (activeTurnId) => {
      const initial = deferred<unknown>();
      const refresh = deferred<unknown>();
      const history = { baseSequence: 0, items: [], turns: [], interactions: [], activeTurnId };
      const getHistory = vi
        .fn()
        .mockReturnValueOnce(initial.promise)
        .mockReturnValueOnce(refresh.promise);
      const controller = new ChatController({
        ...environment(),
        relay: {
          getHistory,
          startTurn: vi.fn(),
          interruptTurn: vi.fn(),
          respondInteraction: vi.fn(),
        },
        publish: vi.fn(),
        websocket: () => new Socket() as unknown as WebSocket,
      });
      try {
        controller.select('s');
        expect(controller.view.status).toBe('Loading conversation…');
        initial.resolve(history);
        await vi.waitFor(() => expect(controller.view.snapshotting).toBe(false));
        const status = controller.view.status;
        controller.refresh();
        expect(controller.view.snapshotting).toBe(true);
        expect(controller.view.status).toBe(status);
        refresh.resolve(history);
        await vi.waitFor(() => expect(controller.view.snapshotting).toBe(false));
        expect(controller.view.status).toBe(status);
      } finally {
        initial.resolve(history);
        refresh.resolve(history);
        controller.dispose();
      }
    },
  );

  it('consumes supervision journal events without creating gaps in chat or the agent overview', async () => {
    const activity = {
      sessionId: 's',
      root: {
        state: 'idle' as const,
        observedAt: '2026-10-31T12:00:00Z',
        lastActivityAt: '2026-10-31T12:00:00Z',
      },
      subagents: [],
      aggregateSubagents: 'idle' as const,
      confidence: 'fresh' as const,
    };
    const refreshActivity = vi.fn().mockResolvedValue(undefined);
    const confidence: string[] = [];
    const activityController = new AgentActivityController({
      relay: {
        getSession: async () => ({ agentActivity: activity, currentSequence: 0 }),
        refreshActivity,
      },
      publish: (snapshots) => {
        const state = snapshots.get('s');
        if (state) confidence.push(state.confidence);
      },
      location: environment().location,
    });
    activityController.bootstrap([{ id: 's', agentActivity: activity }], 's');
    const socket = new Socket();
    const getHistory = vi.fn().mockResolvedValue({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: 'turn',
    });
    const statuses: string[] = [];
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: (view) => statuses.push(view.status),
      websocket: () => socket as unknown as WebSocket,
      onRelayEvent: (event) => activityController.observe('s', event),
    });
    try {
      controller.select('s');
      await vi.waitFor(() => expect(controller.view.status).toBe('Codex is working…'));
      statuses.length = 0;
      socket.emit({
        type: 'relay.event',
        event: { sequence: 1, type: 'autopilot.wait-registered', payload: { waitId: 'wait' } },
      });
      socket.emit({
        type: 'relay.event',
        event: { sequence: 2, type: 'org-plan.step-checkpointed', payload: { stepId: 'step' } },
      });
      socket.emit({
        type: 'relay.event',
        event: { sequence: 3, type: 'agent.activity.updated', payload: activity },
      });
      expect(controller.view.cursor).toBe(3);
      expect(controller.view.snapshotting).toBe(false);
      expect(getHistory).toHaveBeenCalledOnce();
      expect(refreshActivity).not.toHaveBeenCalled();
      expect(statuses.every((status) => status === 'Codex is working…')).toBe(true);
      expect(confidence).not.toContain('reconciling');
    } finally {
      controller.dispose();
      activityController.dispose();
    }
  });

  it('reports real socket loss immediately and keeps it visible through offline history reads', async () => {
    const sockets: Socket[] = [];
    const timers: Array<() => void> = [];
    const pending = deferred<unknown>();
    const snapshot = {
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: 'turn',
    };
    const getHistory = vi.fn().mockResolvedValue(snapshot);
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    try {
      controller.select('s');
      await vi.waitFor(() => expect(controller.view.status).toBe('Codex is working…'));
      sockets[0]!.onclose?.();
      expect(controller.view.status).toBe('Connection interrupted. Reconnecting…');
      getHistory.mockReturnValueOnce(pending.promise);
      controller.refresh();
      pending.resolve(snapshot);
      await vi.waitFor(() => expect(controller.view.snapshotting).toBe(false));
      expect(controller.view.status).toBe('Connection interrupted. Reconnecting…');
      timers.at(-1)!();
      sockets[1]!.onopen?.();
      await vi.waitFor(() => expect(controller.view.status).toBe('Codex is working…'));
      sockets[1]!.onclose?.();
      controller.select('other', { history: 'empty' });
      expect(controller.view.status).toBe('Ready.');
    } finally {
      pending.resolve(snapshot);
      controller.dispose();
    }
  });

  it('forwards validated efficiency replacement events for the selected session only', async () => {
    const socket = new Socket();
    const forwarded: unknown[] = [];
    const controller = new ChatController({
      relay: {
        getHistory: async () => ({
          items: [],
          turns: [],
          activeTurnId: null,
          interactions: [],
          baseSequence: 0,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      cache: { read: async () => null, write: async () => {} },
      publish: () => {},
      websocket: () => socket as unknown as WebSocket,
      ...environment(),
      onRelayEvent: (event) => forwarded.push(event.payload),
    });
    controller.select('s');
    await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
    socket.emit({
      type: 'relay.event',
      event: {
        sequence: 1,
        type: 'tool.efficiency.updated',
        payload: { ...efficiencyFixture('s'), privateOutput: 'secret' },
      },
    });
    socket.emit({
      type: 'relay.event',
      event: { sequence: 2, type: 'tool.efficiency.updated', payload: efficiencyFixture('other') },
    });
    socket.emit({
      type: 'relay.event',
      event: {
        sequence: 3,
        type: 'tool.efficiency.updated',
        payload: { sessionId: 's', private: 'secret' },
      },
    });
    expect(forwarded).toEqual([efficiencyFixture('s')]);
    controller.dispose();
  });
  it('tracks each continuous Ready episode without resetting on idle updates', async () => {
    let now = 1_000;
    const socket = new Socket();
    const getHistory = vi.fn().mockResolvedValue({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const controller = new ChatController({
      ...environment(),
      now: () => now,
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => socket as unknown as WebSocket,
    });
    try {
      controller.select('s');
      await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
      expect(controller.view.readySince).toBe(1_000);
      now = 61_000;
      controller.refresh();
      await vi.waitFor(() => expect(getHistory).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
      expect(controller.view.readySince).toBe(1_000);
      socket.emit({
        type: 'relay.event',
        event: {
          sequence: 1,
          type: 'session.updated',
          payload: { activeTurnId: null },
        },
      });
      expect(controller.view.readySince).toBe(1_000);
      socket.emit({
        type: 'relay.event',
        event: {
          sequence: 2,
          type: 'session.updated',
          payload: { activeTurnId: 'turn' },
        },
      });
      expect(controller.view.readySince).toBeNull();
      now = 121_000;
      socket.emit({
        type: 'relay.event',
        event: {
          sequence: 3,
          type: 'turnCompleted',
          payload: null,
        },
      });
      expect(controller.view.readySince).toBe(121_000);
      now = 181_000;
      controller.select('other', { history: 'empty' });
      expect(controller.view.readySince).toBe(181_000);
      controller.select(null);
      expect(controller.view.readySince).toBeNull();
    } finally {
      controller.dispose();
    }
  });
  it('hydrates once and immediately replaces a resync socket even without buffered events', async () => {
    const history = deferred<unknown>();
    const getHistory = vi.fn().mockReturnValue(history.promise);
    const sockets: Socket[] = [];
    const urls: string[] = [];
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    try {
      controller.select('s');
      sockets[0]!.emit({ type: 'relay.resyncRequired', currentSequence: 1000 });
      history.resolve({
        baseSequence: 1000,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: null,
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(sockets[0]!.close).toHaveBeenCalledOnce();
      expect(urls[1]).toMatch(/after=1000$/);
      sockets[1]!.onopen?.();
      await Promise.resolve();
      expect(getHistory).toHaveBeenCalledOnce();
      expect(controller.view.status).toBe('Ready.');
    } finally {
      controller.dispose();
    }
  });

  it('refreshes an in-flight snapshot below the resync fence before reopening its socket', async () => {
    const initial = deferred<unknown>();
    const sockets: Socket[] = [];
    const urls: string[] = [];
    const getHistory = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue({
      baseSequence: 4,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    try {
      controller.select('s');
      sockets[0]!.emit({ type: 'relay.resyncRequired', currentSequence: 4 });
      sockets[0]!.onclose?.();
      initial.resolve({
        baseSequence: 0,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: null,
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(urls[1]).toMatch(/after=4$/);
      expect(getHistory).toHaveBeenCalledTimes(2);
      sockets[1]!.emit({
        type: 'relay.event',
        event: { sequence: 5, type: 'agentMessageDelta', payload: { text: 'live again' } },
      });
      await Promise.resolve();
      expect(sockets).toHaveLength(2);
      expect(controller.view.messages.at(-1)?.text).toBe('live again');
    } finally {
      controller.dispose();
    }
  });
  it('bounds stale resync snapshots and reports recovery failure without reopening', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const socket = new Socket();
    const websocket = vi.fn(() => socket as unknown as WebSocket);
    const getHistory = vi.fn().mockResolvedValue({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const onHistoryError = vi.fn();
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket,
      onHistoryError,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    const settle = async () => {
      for (let index = 0; index < 5; index++) await Promise.resolve();
    };
    try {
      controller.select('s');
      socket.emit({ type: 'relay.resyncRequired', currentSequence: 4 });
      socket.onclose?.();
      for (const delay of [250, 750, 1500]) {
        await settle();
        expect(timers.at(-1)?.delay).toBe(delay);
        timers.at(-1)?.callback();
      }
      await settle();
      expect(getHistory).toHaveBeenCalledTimes(4);
      expect(websocket).toHaveBeenCalledOnce();
      expect(timers).toHaveLength(3);
      expect(onHistoryError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'CHAT_SNAPSHOT_BEHIND_RESYNC' }),
      );
      expect(controller.view.lifecycle).toBe('recoverable');
    } finally {
      controller.dispose();
    }
  });
  it('does not refetch history when the initial socket opens after hydration', async () => {
    const getHistory = vi.fn().mockResolvedValue({
      baseSequence: 3,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const socket = new Socket();
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => socket as unknown as WebSocket,
    });
    try {
      controller.select('s');
      await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
      socket.onopen?.();
      await Promise.resolve();
      expect(getHistory).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });
  it('does not read history for a newly created session whose timeline is known to be empty', async () => {
    const env = environment();
    const history = vi.fn();
    const onHistoryError = vi.fn();
    const socket = new Socket();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => socket as unknown as WebSocket,
      onHistoryError,
    });

    controller.select('new-session', { history: 'empty' });
    socket.onopen?.();
    await Promise.resolve();

    socket.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'session.updated', payload: { activeTurnId: null } },
    });
    socket.emit({
      type: 'relay.event',
      event: {
        sequence: 2,
        type: 'session.status.updated',
        payload: { state: 'idle', reason: 'unknown' },
      },
    });
    for (const [index, status] of ['starting', 'ready'].entries())
      socket.emit({
        type: 'relay.event',
        event: {
          sequence: 3 + index,
          type: 'activity.updated',
          payload: {
            id: 'startup',
            label: 'XERJ startup',
            detail: status,
            mcpStartup: {
              schemaVersion: 1,
              runtimeId: 'runtime',
              attemptId: 'attempt',
              threadId: 'thread',
              serverName: 'gestalt-xerj',
              observedAt: '2026-10-31T12:00:00.000Z',
              status,
              failure: null,
            },
          },
        },
      });
    expect(controller.view.activities).toHaveLength(1);
    expect(controller.view.newEmpty).toBe(true);
    controller.refresh();
    controller.select(null);
    controller.select('new-session');
    socket.onopen?.();
    controller.refresh();
    expect(controller.view.newEmpty).toBe(true);
    expect(history).not.toHaveBeenCalled();
    expect(onHistoryError).not.toHaveBeenCalled();
    expect(controller.view).toMatchObject({
      sessionId: 'new-session',
      snapshotting: false,
      lifecycle: 'finished',
      messages: [],
    });
    controller.dispose();
  });

  it('keeps missing history quiet for a new empty chat until conversation activity starts', async () => {
    const timers: Array<() => void> = [];
    const settle = async () => {
      for (let index = 0; index < 6; index++) await Promise.resolve();
    };
    const socket = new Socket();
    const onHistoryError = vi.fn();
    const history = vi.fn().mockRejectedValue(new Error('history not created'));
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => socket as unknown as WebSocket,
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
      onHistoryError,
    });
    controller.select('new', { history: 'empty' });
    socket.emit({ type: 'relay.resyncRequired' });
    await settle();
    for (let index = 0; index < 3; index++) {
      timers.at(-1)?.();
      await settle();
    }
    expect(history).toHaveBeenCalledTimes(4);
    expect(onHistoryError).not.toHaveBeenCalled();
    expect(controller.view.newEmpty).toBe(true);
    socket.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'session.updated', payload: { activeTurnId: 'turn' } },
    });
    expect(controller.view.newEmpty).toBe(false);
    controller.refresh();
    await settle();
    expect(onHistoryError).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('queues active-turn input through Codex steering and keeps the turn working', async () => {
    const env = environment();
    const queueTurnInput = vi.fn().mockResolvedValue({ activeTurnId: 'turn-1' });
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: 'turn-1',
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        queueTurnInput,
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.queue('  focus on tests  ', 'queued-message');
    expect(queueTurnInput).toHaveBeenCalledWith('s', 'turn-1', 'focus on tests', 'queued-message');
    expect(controller.view).toMatchObject({ activeTurnId: 'turn-1', lifecycle: 'working' });
    expect(controller.view.prompts[0]).toMatchObject({
      operationId: 'queued-message',
      state: 'accepted',
      turnId: 'turn-1',
    });
    controller.dispose();
  });

  it('interrupts the active turn before starting the replacement prompt', async () => {
    const env = environment();
    const order: string[] = [];
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: 'turn-1',
        }),
        startTurn: vi.fn(async () => {
          order.push('start');
          return { activeTurnId: 'turn-2' };
        }),
        interruptTurn: vi.fn(async () => {
          order.push('interrupt');
        }),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.interruptAndSend('restart here', 'replacement-message');
    expect(order).toEqual(['interrupt', 'start']);
    expect(controller.view).toMatchObject({ activeTurnId: 'turn-2', lifecycle: 'working' });
    controller.dispose();
  });

  it('retries interrupt-and-send while the interrupted turn is still settling', async () => {
    const env = environment();
    const active = Object.assign(new Error('still active'), { code: 'SESSION_TURN_ACTIVE' });
    const startTurn = vi
      .fn()
      .mockRejectedValueOnce(active)
      .mockResolvedValue({ activeTurnId: 'turn-2' });
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: 'turn-1',
        }),
        startTurn,
        interruptTurn: vi.fn().mockResolvedValue(undefined),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      setTimeout: (callback) => {
        callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.interruptAndSend('restart here', 'replacement-message');
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(controller.view.activeTurnId).toBe('turn-2');
    controller.dispose();
  });

  it('uses its injected clock for the optimistic prompt occurrence time', async () => {
    const env = environment();
    const controller = new ChatController({
      ...env,
      now: () => 1_784_102_400_000,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn().mockResolvedValue({ activeTurnId: 'turn-1' }),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await controller.send('prompt', 'operation');
    expect(controller.view.messages[0]).toMatchObject({
      id: 'prompt:operation',
      occurredAt: 1_784_102_400_000,
    });
    controller.dispose();
  });
  it('reports a rejected writer acquisition and preserves its operation identifier for retry', async () => {
    const env = environment();
    const rejected = Object.assign(new Error('safe detail'), { code: 'SESSION_WRITER_BUSY' });
    const start = vi
      .fn()
      .mockRejectedValueOnce(rejected)
      .mockResolvedValue({ activeTurnId: 'turn-1' });
    const onSendError = vi.fn();
    const onSendAccepted = vi.fn();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: start,
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      onSendError,
      onSendAccepted,
    });
    controller.select('s');
    await Promise.resolve();
    await controller.send('prompt', 'stable-operation');
    expect(onSendError).toHaveBeenCalledWith(rejected, 'stable-operation');
    expect(controller.view.prompts[0]).toMatchObject({
      state: 'failed',
      operationId: 'stable-operation',
    });
    await controller.retryPrompt('stable-operation');
    expect(start).toHaveBeenNthCalledWith(2, 's', 'prompt', 'stable-operation');
    expect(onSendAccepted).toHaveBeenCalledWith('s', 'stable-operation');
    controller.dispose();
  });
  it('reports relay acceptance for the captured session after selection changes', async () => {
    const env = environment();
    const result = deferred<{ activeTurnId: string }>();
    const onSendAccepted = vi.fn();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn().mockReturnValue(result.promise),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      onSendAccepted,
    });
    controller.select('a');
    await Promise.resolve();
    const sending = controller.send('private instruction', 'operation-a');
    controller.select('b');
    result.resolve({ activeTurnId: 'turn-a' });
    await sending;
    expect(onSendAccepted).toHaveBeenCalledWith('a', 'operation-a');
    expect(controller.view.sessionId).toBe('b');
    controller.dispose();
  });
  it('reports an accepted operation discovered in authoritative history after reload', async () => {
    const env = environment();
    const onHistoryPromptAccepted = vi.fn();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 1,
          items: [
            {
              id: 'user-1',
              kind: 'user',
              text: 'private instruction',
              operationId: 'recovered-operation',
            },
          ],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      onHistoryPromptAccepted,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(onHistoryPromptAccepted).toHaveBeenCalledWith('s', 'recovered-operation');
    controller.dispose();
  });
  it('takes a second snapshot when a gap arrives during the initial snapshot', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const sockets: Socket[] = [];
    const env = environment();
    const history = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'gap' } },
    });
    first.resolve({ baseSequence: 0, items: [], turns: [], interactions: [], activeTurnId: null });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(history).toHaveBeenCalledTimes(2);
    second.resolve({ baseSequence: 2, items: [], turns: [], interactions: [], activeTurnId: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.view.snapshotting).toBe(false);
    expect(controller.view.cursor).toBeGreaterThanOrEqual(2);
    controller.dispose();
  });
  it('treats a malformed gap recovery snapshot as recoverable without retrying tightly', async () => {
    const first = deferred<unknown>();
    const sockets: Socket[] = [];
    const env = environment();
    const history = vi.fn().mockReturnValue(first.promise);
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'gap' } },
    });
    first.resolve({ baseSequence: 'bad' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(history).toHaveBeenCalledTimes(1);
    expect(controller.view).toMatchObject({ snapshotting: false, lifecycle: 'recoverable' });
    controller.dispose();
  });
  it('does not let an A interaction key block B', async () => {
    const pending = deferred<void>();
    const env = environment();
    const respond = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [
            {
              requestId: 'r',
              kind: 'x',
              turnId: null,
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
          ],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: respond,
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('a');
    await Promise.resolve();
    await Promise.resolve();
    const a = controller.respond('r', { decision: 'accept' }, 'K');
    controller.select('b');
    await Promise.resolve();
    await Promise.resolve();
    await controller.respond('r', { decision: 'accept' }, 'K');
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    pending.resolve();
    await a;
    expect(controller.view.sessionId).toBe('b');
    controller.dispose();
  });
  it('serializes reversed snapshots and buffers events during a snapshot without duplicate sockets', async () => {
    const history = deferred<unknown>();
    const sockets: Socket[] = [];
    const views: ChatViewState[] = [];
    const env = environment();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockReturnValue(history.promise),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: (view) => views.push(view),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'during' } },
    });
    history.resolve({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    await history.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    expect(views.at(-1)?.messages[0]?.text).toBe('during');
    controller.dispose();
  });
  it('recovers gap/reconnect/foreground, rejects malformed data, and never publishes a disposed or prior generation', async () => {
    const sockets: Socket[] = [];
    const views: ChatViewState[] = [];
    const env = environment();
    const relay = {
      getHistory: vi.fn().mockResolvedValue({
        baseSequence: 0,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: null,
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      respondInteraction: vi.fn(),
    };
    const controller = new ChatController({
      ...env,
      relay,
      publish: (view) => views.push(view),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      setTimeout: (fn) => {
        fn();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    controller.select('one');
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.emit('not-json');
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'gap' } },
    });
    sockets[0]?.onclose?.();
    controller.select('two');
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'stale' } },
    });
    expect(relay.getHistory.mock.calls.length).toBeGreaterThan(0);
    expect(views.at(-1)?.sessionId).toBe('two');
    controller.dispose();
    const count = views.length;
    sockets.at(-1)?.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'late' } },
    });
    expect(views).toHaveLength(count);
  });
  it('survives cache failure/reload pending outbox and converges lost command responses with one key', async () => {
    const views: ChatViewState[] = [];
    const env = environment();
    const start = vi.fn().mockRejectedValue(new Error('lost'));
    const reply = vi.fn().mockRejectedValue(new Error('lost'));
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [
            {
              requestId: 'r',
              kind: 'x',
              turnId: null,
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
          ],
          activeTurnId: null,
        }),
        startTurn: start,
        interruptTurn: vi.fn(),
        respondInteraction: reply,
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
      cache: {
        read: vi.fn().mockRejectedValue(new Error('idb')),
        write: vi.fn().mockRejectedValue(new Error('idb')),
      },
      createKey: () => 'stable',
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.send('prompt');
    await controller.retryPrompt('stable');
    await controller.respond('r', { decision: 'accept' }, 'response-key');
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.every((call) => call[2] === 'stable')).toBe(true);
    expect(reply).toHaveBeenCalledWith('s', 'r', { decision: 'accept' }, 'response-key');
    expect(views.at(-1)?.prompts[0]?.state).toBe('failed');
    controller.dispose();
  });
  it('starts B while A snapshot/cache hangs and gates concurrent operations by their stable key', async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const slowCache = deferred<unknown>();
    const history = vi.fn((id: string) => (id === 'a' ? a.promise : b.promise));
    const start = vi.fn().mockResolvedValue({ activeTurnId: 't' });
    const env = environment();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: history,
        startTurn: start,
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      cache: {
        read: vi.fn().mockReturnValue(slowCache.promise),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    controller.select('a');
    controller.select('b');
    await Promise.resolve();
    expect(history).toHaveBeenCalledWith('a', { attempts: 1, coalesced: 0 });
    expect(history).toHaveBeenCalledWith('b', { attempts: 1, coalesced: 0 });
    b.resolve({ baseSequence: 0, items: [], turns: [], interactions: [], activeTurnId: null });
    await controller.send('one', 'same');
    await Promise.all([controller.send('two', 'same'), controller.send('two', 'same')]);
    expect(start).toHaveBeenCalledTimes(1);
    a.resolve({ baseSequence: 0, items: [], turns: [], interactions: [], activeTurnId: null });
    slowCache.resolve(null);
    controller.dispose();
  });
  it('uses one snapshot/socket pipeline across duplicate replay, close/backoff and foreground refresh', async () => {
    const sockets: Socket[] = [];
    const timers: Array<() => void> = [];
    const env = environment();
    const relay = {
      getHistory: vi.fn().mockResolvedValue({
        baseSequence: 0,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: null,
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      respondInteraction: vi.fn(),
    };
    const controller = new ChatController({
      ...env,
      relay,
      publish: vi.fn(),
      websocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'once' } },
    });
    sockets[0]?.emit({
      type: 'relay.event',
      event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'duplicate' } },
    });
    expect(controller.view.messages).toHaveLength(1);
    sockets[0]?.onclose?.();
    timers.at(-1)?.();
    expect(sockets.length).toBeLessThanOrEqual(2);
    controller.refresh();
    controller.refresh();
    await Promise.resolve();
    expect(relay.getHistory.mock.calls.length).toBeGreaterThan(0);
    controller.dispose();
  });
  it('handles interaction before deferred turn response, retries a lost response, and receives final only on resume', async () => {
    const turn = deferred<{ activeTurnId?: string }>();
    const reply = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue(undefined);
    const views: ChatViewState[] = [];
    const env = environment();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [
            {
              requestId: 'r',
              kind: 'x',
              turnId: null,
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
          ],
          activeTurnId: null,
        }),
        startTurn: vi.fn().mockReturnValue(turn.promise),
        interruptTurn: vi.fn(),
        respondInteraction: reply,
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
      createKey: () => 'key',
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    const sending = controller.send('prompt', 'turn-key');
    await controller.respond('r', { safe: true }, 'reply-key');
    await controller.retryInteraction('r');
    turn.resolve({ activeTurnId: 't' });
    await sending;
    expect(reply).toHaveBeenCalledTimes(2);
    controller.select(null);
    controller.select('s');
    await Promise.resolve();
    expect(views.at(-1)?.sessionId).toBe('s');
    controller.dispose();
  });
  it('does not let a late cache overwrite an authoritative base-zero snapshot or publish unknown payloads', async () => {
    const cache = deferred<unknown>();
    const views: ChatViewState[] = [];
    const env = environment();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [{ id: 'u', kind: 'user', text: 'authoritative' }],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
      cache: {
        read: vi.fn().mockReturnValue(cache.promise),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    cache.resolve({
      cursor: 0,
      messages: [{ id: 'cached', role: 'user', text: 'stale' }],
      prompts: [],
      interactions: [],
    });
    await Promise.resolve();
    expect(controller.view.messages.map((item) => item.text)).toContain('authoritative');
    controller.dispose();
  });
  it('renders a canonical final supplied only by the resumed snapshot', async () => {
    const env = environment();
    const views: ChatViewState[] = [];
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 4,
          items: [
            {
              id: 'final',
              kind: 'agent',
              text: 'resumed final',
              phase: 'final_answer',
              turnId: 't',
            },
          ],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(views.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'resumed final', phase: 'final_answer', complete: true }),
      ]),
    );
    expect(views.at(-1)?.lifecycle).toBe('finished');
    controller.dispose();
  });
  it('reconnects from the recovered cursor without honoring the stale socket close', async () => {
    const sockets: Socket[] = [];
    const urls: string[] = [];
    const timers: Array<() => void> = [];
    const env = environment();
    const relay = {
      getHistory: vi
        .fn()
        .mockResolvedValueOnce({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        })
        .mockResolvedValueOnce({
          baseSequence: 2,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      respondInteraction: vi.fn(),
    };
    const controller = new ChatController({
      ...env,
      relay,
      publish: vi.fn(),
      websocket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const old = sockets[0]!;
    old.emit({
      type: 'relay.event',
      event: { sequence: 3, type: 'agentMessageDelta', payload: { text: 'buffered' } },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(old.close).toHaveBeenCalled();
    expect(urls.at(-1)).toMatch(/after=3$/);
    const before = sockets.length;
    old.onclose?.();
    expect(sockets).toHaveLength(before);
    expect(timers).toHaveLength(0);
    controller.dispose();
  });
  it('coalesces visible foreground recovery and ignores hidden visibility', async () => {
    const pending = deferred<unknown>();
    const handlers: Record<string, (() => void)[]> = {};
    const document = {
      visibilityState: 'visible',
      addEventListener: (name: string, fn: () => void) => (handlers[name] ??= []).push(fn),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const window = {
      addEventListener: (name: string, fn: () => void) => (handlers[name] ??= []).push(fn),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const history = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const controller = new ChatController({
      document,
      window,
      location: { protocol: 'http:', host: 'x' } as Location,
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    handlers.visibilitychange?.[0]?.();
    handlers.focus?.[0]?.();
    expect(history).toHaveBeenCalledTimes(1);
    pending.resolve({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    handlers.visibilitychange?.[0]?.();
    expect(history).toHaveBeenCalledTimes(1);
    (document as unknown as { visibilityState: string }).visibilityState = 'visible';
    handlers.focus?.[0]?.();
    expect(history).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
  it('keeps streamed activity when a foreground refresh omits it', async () => {
    const handlers: Record<string, (() => void)[]> = {};
    const document = {
      visibilityState: 'visible',
      addEventListener: (name: string, fn: () => void) => (handlers[name] ??= []).push(fn),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const window = {
      addEventListener: (name: string, fn: () => void) => (handlers[name] ??= []).push(fn),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        baseSequence: 0,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: 'turn-1',
      })
      .mockResolvedValue({
        baseSequence: 1,
        items: [],
        turns: [],
        interactions: [],
        activeTurnId: null,
      });
    const socket = new Socket();
    const controller = new ChatController({
      document,
      window,
      location: { protocol: 'http:', host: 'x' } as Location,
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => socket as unknown as WebSocket,
    });
    controller.select('s');
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(controller.view.snapshotting).toBe(false));
    await Promise.resolve();
    socket.emit({
      type: 'relay.event',
      event: {
        sequence: 1,
        type: 'activity.updated',
        payload: {
          id: 'activity-1',
          label: 'Command · completed',
          detail: 'npm test',
          turnId: 'turn-1',
        },
      },
    });
    expect(controller.view.activities).toHaveLength(1);

    handlers.focus?.[0]?.();
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.view.snapshotting).toBe(false));

    expect(controller.view.activities).toEqual([
      {
        id: 'activity-1',
        label: 'Command · completed',
        detail: 'npm test',
        turnId: 'turn-1',
      },
    ]);
    controller.dispose();
  });
  it('silently retries a transient initial history race and accepts the recovered snapshot', async () => {
    const settle = async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const history = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue({
      baseSequence: 0,
      items: [],
      turns: [],
      interactions: [],
      activeTurnId: null,
    });
    const onHistoryError = vi.fn();
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
      onHistoryError,
    });

    controller.select('new-session');
    await settle();
    expect(history).toHaveBeenCalledTimes(1);
    expect(onHistoryError).not.toHaveBeenCalled();
    expect(timers[0]?.delay).toBe(250);

    timers[0]?.callback();
    await settle();
    expect(history).toHaveBeenCalledTimes(2);
    expect(onHistoryError).not.toHaveBeenCalled();
    expect(controller.view).toMatchObject({ snapshotting: false, lifecycle: 'finished' });
    controller.dispose();
  });
  it('reports a persistent history failure once after bounded retries', async () => {
    const settle = async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const failure = new Error('persistent');
    const history = vi.fn().mockRejectedValue(failure);
    const onHistoryError = vi.fn();
    const controller = new ChatController({
      ...environment(),
      relay: {
        getHistory: history,
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
      onHistoryError,
    });

    controller.select('session');
    for (const expectedDelay of [250, 750, 1_500]) {
      await settle();
      expect(timers.at(-1)?.delay).toBe(expectedDelay);
      timers.at(-1)?.callback();
    }
    await settle();
    expect(history).toHaveBeenCalledTimes(4);
    expect(onHistoryError).toHaveBeenCalledOnce();
    expect(onHistoryError).toHaveBeenCalledWith(failure);

    controller.refresh();
    await settle();
    expect(history).toHaveBeenCalledTimes(5);
    expect(onHistoryError).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it('does not let an A command with key same block or publish into B', async () => {
    const a = deferred<{ activeTurnId?: string }>();
    const views: ChatViewState[] = [];
    const env = environment();
    const start = vi
      .fn()
      .mockReturnValueOnce(a.promise)
      .mockResolvedValueOnce({ activeTurnId: 'b-turn' });
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: start,
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('a');
    await Promise.resolve();
    const sendingA = controller.send('A', 'same');
    controller.select('b');
    await Promise.resolve();
    await controller.send('B', 'same');
    expect(start).toHaveBeenCalledTimes(2);
    expect(controller.view.sessionId).toBe('b');
    expect(controller.view.prompts.map((item) => item.text)).toEqual(['B']);
    a.resolve({ activeTurnId: 'a-turn' });
    await sendingA;
    expect(controller.view.activeTurnId).toBe('b-turn');
    controller.dispose();
  });
  it.each([
    { items: [null] },
    { turns: [null] },
    { interactions: [null] },
    { baseSequence: -1 },
    { activeTurnId: 7 },
  ])('rejects malformed snapshot %# without mutation', async (bad) => {
    const env = environment();
    const callback = vi.fn();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
          ...bad,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      onSessionEvent: callback,
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.view.messages).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
    controller.dispose();
  });
  it.each([
    { turns: [{ id: 't', items: [null], startedAt: null, completedAt: null }] },
    {
      interactions: [
        { requestId: 'p', kind: 'x', turnId: null, requestedAt: null, resolvedAt: null },
      ],
    },
    {
      interactions: [
        { requestId: 'r', kind: 'x', turnId: null, requestedAt: null, resolvedAt: 'now' },
      ],
    },
    {
      interactions: [
        {
          requestId: 'r',
          kind: 'x',
          turnId: null,
          requestedAt: null,
          resolvedAt: 'now',
          outcome: 'bad',
        },
      ],
    },
    {
      interactions: [
        {
          requestId: 'r',
          kind: 'x',
          turnId: null,
          requestedAt: null,
          resolvedAt: 'now',
          outcome: 'approved',
          payload: {},
        },
      ],
    },
  ])('rejects discriminator-malformed snapshot %#', async (bad) => {
    const env = environment();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
          ...bad,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.view.messages).toHaveLength(0);
    controller.dispose();
  });
  it.each([
    { sequence: 1, type: 'unknown', payload: {} },
    { sequence: 1, type: 'agentMessageDelta', payload: {} },
    { sequence: -1, type: 'turnCompleted', payload: {} },
  ])('rejects malformed websocket event %# without callback', async (event) => {
    const env = environment();
    const callback = vi.fn();
    const socket = new Socket();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      onSessionEvent: callback,
      websocket: () => socket as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    socket.emit({ type: 'relay.event', event });
    expect(controller.view.cursor).toBe(0);
    expect(callback).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('keeps chat events local and emits only session and plan metadata', async () => {
    const env = environment();
    const callback = vi.fn();
    const socket = new Socket();
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          interactions: [],
          activeTurnId: null,
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn(),
      },
      publish: vi.fn(),
      onSessionEvent: callback,
      websocket: () => socket as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    [
      'activity.updated',
      'agentMessageDelta',
      'session.updated',
      'plan.updated',
      'plan.closed',
    ].forEach((type, index) =>
      socket.emit({
        type: 'relay.event',
        event: {
          sequence: index + 1,
          type,
          payload:
            type === 'activity.updated'
              ? { id: 'a', label: 'x', detail: 'y' }
              : type === 'agentMessageDelta'
                ? { text: 'x' }
                : type === 'session.updated'
                  ? { activeTurnId: null }
                  : {},
        },
      }),
    );
    expect(controller.view.activities).toHaveLength(1);
    expect(callback.mock.calls.map(([event]) => event.type)).toEqual([
      'session.updated',
      'plan.updated',
      'plan.closed',
    ]);
    controller.dispose();
  });
  it.each(['hydrate', 'empty'] as const)(
    'recovers from a websocket factory throw with %s history',
    async (history) => {
      const env = environment();
      const timers: Array<() => void> = [];
      const socket = new Socket();
      let calls = 0;
      const controller = new ChatController({
        ...env,
        relay: {
          getHistory: vi.fn().mockResolvedValue({
            baseSequence: 0,
            items: [],
            turns: [],
            interactions: [],
            activeTurnId: null,
          }),
          startTurn: vi.fn(),
          interruptTurn: vi.fn(),
          respondInteraction: vi.fn(),
        },
        publish: vi.fn(),
        websocket: () => {
          if (calls++ === 0) throw new Error('open');
          return socket as unknown as WebSocket;
        },
        setTimeout: (fn) => {
          timers.push(fn);
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: vi.fn(),
      });
      try {
        controller.select('s', history === 'empty' ? { history: 'empty' } : {});
        await Promise.resolve();
        expect(controller.view.status).toBe('Connection interrupted. Reconnecting…');
        expect(timers).toHaveLength(1);
        timers[0]?.();
        expect(calls).toBe(2);
        socket.onopen?.();
        await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
      } finally {
        controller.dispose();
      }
    },
  );
  it('retries hydrated safe approval but requires quiz re-entry', async () => {
    const env = environment();
    const reply = vi.fn().mockResolvedValue(undefined);
    const cache = {
      cursor: 0,
      messages: [],
      prompts: [],
      interactions: [
        {
          requestId: 'a',
          key: 'a',
          kind: 'commandApproval',
          state: 'failed',
          operationId: 'ka',
          attemptedOutcome: 'approved',
        },
        { requestId: 'q', key: 'q', kind: 'quiz', state: 'failed', operationId: 'kq' },
      ],
    };
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockReturnValue(new Promise(() => {})),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: reply,
      },
      publish: vi.fn(),
      websocket: () => new Socket() as unknown as WebSocket,
      cache: {
        read: vi.fn().mockResolvedValue(cache),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.retryInteraction('a');
    await controller.retryInteraction('q');
    await controller.retryInteraction('q', { answer: 'reentered' });
    expect(reply).toHaveBeenNthCalledWith(1, 's', 'a', { decision: 'accept' }, 'ka');
    expect(reply).toHaveBeenNthCalledWith(2, 's', 'q', { answer: 'reentered' }, 'kq');
    controller.dispose();
  });
  it('normalizes live interaction success into presentation-safe outcomes', async () => {
    const env = environment();
    const views: ChatViewState[] = [];
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          activeTurnId: 'turn-1',
          interactions: [
            {
              requestId: 'deny',
              kind: 'commandApproval',
              turnId: 'turn-1',
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
            {
              requestId: 'quiz',
              kind: 'quiz',
              turnId: 'turn-1',
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
            {
              requestId: 'permission',
              kind: 'permissionsApproval',
              turnId: 'turn-1',
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
          ],
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn().mockResolvedValue(undefined),
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.respond('deny', { decision: 'decline' });
    await controller.respond('quiz', { answers: ['secret'] });
    await controller.respond('permission', { granted: true });
    expect(views.at(-1)?.interactions.map((item) => item.attemptedOutcome)).toEqual([
      'denied',
      'answered',
      'approved',
    ]);
    controller.dispose();
  });

  it('uses the relay outcome when an interaction was already cleared upstream', async () => {
    const env = environment();
    const views: ChatViewState[] = [];
    const controller = new ChatController({
      ...env,
      relay: {
        getHistory: vi.fn().mockResolvedValue({
          baseSequence: 0,
          items: [],
          turns: [],
          activeTurnId: 'turn-1',
          interactions: [
            {
              requestId: 'stale',
              kind: 'commandApproval',
              turnId: 'turn-1',
              requestedAt: null,
              resolvedAt: null,
              payload: {},
            },
          ],
        }),
        startTurn: vi.fn(),
        interruptTurn: vi.fn(),
        respondInteraction: vi.fn().mockResolvedValue({ outcome: 'dismissed' }),
      },
      publish: (view) => views.push(view),
      websocket: () => new Socket() as unknown as WebSocket,
    });
    controller.select('s');
    await Promise.resolve();
    await Promise.resolve();
    await controller.respond('stale', { decision: 'accept' });
    expect(views.at(-1)?.interactions[0]).toMatchObject({
      state: 'resolved',
      attemptedOutcome: 'dismissed',
    });
    controller.dispose();
  });
});

it('preserves coalesced refresh evidence without sending duplicate history reads', async () => {
  let finish!: (value: unknown) => void;
  const getHistory = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new ChatController({
    ...environment(),
    relay: { getHistory, startTurn: vi.fn(), interruptTurn: vi.fn(), respondInteraction: vi.fn() },
    publish: vi.fn(),
    websocket: () => new Socket() as unknown as WebSocket,
  });
  try {
    controller.select('s');
    controller.refresh();
    controller.refresh();
    expect(getHistory).toHaveBeenCalledOnce();
    expect(controller.transportDiagnostics).toMatchObject({ attempts: 1, coalesced: 2 });
    finish({ items: [], turns: [], interactions: [], activeTurnId: null, baseSequence: 0 });
    await vi.waitFor(() => expect(controller.view.status).toBe('Ready.'));
    controller.refresh();
    expect(getHistory).toHaveBeenLastCalledWith('s', { attempts: 2, coalesced: 2 });
    controller.select('other');
    expect(controller.transportDiagnostics).toMatchObject({ attempts: 1, coalesced: 0 });
  } finally {
    controller.dispose();
  }
});
