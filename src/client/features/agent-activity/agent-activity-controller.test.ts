/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { AgentActivityController } from './agent-activity-controller.js';
import { isAgentActivitySnapshot } from './contracts.js';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
};

const snapshot = (sessionId: string, state = 'working') => ({
  sessionId,
  root: {
    state,
    observedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  },
  subagents: [],
  aggregateSubagents: 'idle',
  confidence: 'fresh' as const,
});
describe('AgentActivityController', () => {
  it('keys selected socket events by session and ignores replay duplicates', () => {
    const published: string[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: (items) => published.push([...items.keys()].join(',')),
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a', 'b'], 'a');
    controller.observe('a', {
      sequence: 1,
      type: 'agent.activity.updated',
      payload: snapshot('a'),
    });
    controller.observe('a', {
      sequence: 1,
      type: 'agent.activity.updated',
      payload: snapshot('a', 'idle'),
    });
    controller.observe('b', {
      sequence: 1,
      type: 'agent.activity.updated',
      payload: snapshot('b', 'blocked'),
    });
    expect(controller.get('a')?.root.state).toBe('working');
    expect(controller.get('b')?.root.state).toBe('blocked');
    expect(published).toEqual(['a', 'a,b']);
  });
  it('keeps the selected session off card sockets and disposes card sockets', () => {
    const sockets: Array<{ close: () => void }> = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    expect(sockets).toHaveLength(1);
    controller.dispose();
  });
  it('transfers card streams when selection changes without dropping another open session', () => {
    const sockets: WebSocket[] = [];
    const closed: number[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      websocket: () => {
        const index = sockets.length;
        const socket = {
          close: () => closed.push(index),
          onmessage: null,
          onclose: null,
        } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    expect(sockets).toHaveLength(1);
    controller.select('b');
    expect(sockets).toHaveLength(2);
    expect(closed).toEqual([0]);
    controller.dispose();
  });
  it('rejects hostile or cross-session activity DTOs', () => {
    expect(isAgentActivitySnapshot(snapshot('other'), 'expected')).toBe(false);
    expect(isAgentActivitySnapshot({ ...snapshot('s'), subagents: Array(65).fill({}) })).toBe(
      false,
    );
    expect(
      isAgentActivitySnapshot({
        ...snapshot('s'),
        root: { state: 'wat', observedAt: 'now', lastActivityAt: 'now' },
      }),
    ).toBe(false);
  });
  it('ignores a late hydrate after explicit removal', async () => {
    const read = deferred<{ agentActivity?: unknown }>();
    const controller = new AgentActivityController({
      relay: { getSession: () => read.promise, refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a'], 'a');
    controller.remove('a');
    read.resolve({ agentActivity: snapshot('a') });
    await Promise.resolve();
    expect(controller.get('a')).toBeNull();
  });
  it('hydrates an authoritative snapshot without replacing a newer socket event', async () => {
    const read = deferred<{ agentActivity?: unknown; currentSequence?: number }>();
    const sockets: WebSocket[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: () => read.promise, refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'relay.event',
        event: { sequence: 5, type: 'agent.activity.updated', payload: snapshot('b', 'idle') },
      }),
    } as MessageEvent);
    read.resolve({ agentActivity: snapshot('b', 'working'), currentSequence: 4 });
    await Promise.resolve();
    expect(controller.get('b')?.root.state).toBe('idle');
  });
  it('allows a socket update to supersede a bootstrap hint', () => {
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.bootstrap([{ id: 'a', agentActivity: snapshot('a', 'working') }], 'a');
    controller.observe('a', {
      sequence: 1,
      type: 'agent.activity.updated',
      payload: snapshot('a', 'idle'),
    });
    expect(controller.get('a')?.root.state).toBe('idle');
  });
  it('does not let a late bootstrap hint overwrite a socket update', () => {
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a'], 'a');
    controller.observe('a', {
      sequence: 1,
      type: 'agent.activity.updated',
      payload: snapshot('a', 'idle'),
    });
    controller.bootstrap([{ id: 'a', agentActivity: snapshot('a', 'working') }], 'a');
    expect(controller.get('a')?.root.state).toBe('idle');
  });
  it('advances the shared journal through non-activity events before activity', () => {
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a'], 'a');
    controller.observe('a', { sequence: 1, type: 'agentMessageDelta', payload: { text: 'x' } });
    controller.observe('a', {
      sequence: 2,
      type: 'agent.activity.updated',
      payload: snapshot('a', 'idle'),
    });
    expect(controller.get('a')?.root.state).toBe('idle');
  });
  it('coalesces repeated sequence gaps into one refresh', async () => {
    const refresh = deferred<void>();
    let calls = 0;
    const controller = new AgentActivityController({
      relay: {
        getSession: async () => ({}),
        refreshActivity: () => {
          calls++;
          return refresh.promise;
        },
      },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a'], 'a');
    controller.observe('a', { sequence: 3, type: 'agentMessageDelta', payload: {} });
    controller.observe('a', { sequence: 5, type: 'agentMessageDelta', payload: {} });
    expect(calls).toBe(1);
    refresh.resolve();
  });
  it('evicts old resync ownership on remove and preserves a replacement resync', async () => {
    const refreshes = [deferred<void>(), deferred<void>()];
    let refreshCalls = 0;
    let response: { agentActivity?: unknown; currentSequence?: number } = {};
    const controller = new AgentActivityController({
      relay: {
        getSession: async () => response,
        refreshActivity: () => refreshes[refreshCalls++]!.promise,
      },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
    });
    controller.sync(['a'], 'a');
    controller.observe('a', { sequence: 2, type: 'agentMessageDelta', payload: {} });
    controller.remove('a');
    controller.sync(['a'], 'a');
    controller.observe('a', { sequence: 2, type: 'agentMessageDelta', payload: {} });
    expect(refreshCalls).toBe(2);
    response = { agentActivity: snapshot('a', 'idle'), currentSequence: 4 };
    refreshes[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.observe('a', { sequence: 4, type: 'agentMessageDelta', payload: {} });
    expect(refreshCalls).toBe(2);
    refreshes[1]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.get('a')?.root.state).toBe('idle');
  });
  it('accepts a card socket activity callback and ignores it after disposal', () => {
    const sockets: WebSocket[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'relay.event',
        event: { sequence: 1, type: 'agent.activity.updated', payload: snapshot('b') },
      }),
    } as MessageEvent);
    expect(controller.get('b')?.root.state).toBe('working');
    controller.dispose();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'relay.event',
        event: { sequence: 2, type: 'agent.activity.updated', payload: snapshot('b', 'idle') },
      }),
    } as MessageEvent);
    expect(controller.get('b')).toBeNull();
  });
  it('uses bounded reconnect timers and cancels them on removal', () => {
    const queued: Array<() => void> = [];
    const sockets: WebSocket[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      reconnectDelaysMs: [1],
      setTimeout: ((fn: () => void) => {
        queued.push(fn);
        return queued.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    sockets[0]!.onclose?.({} as CloseEvent);
    expect(queued).toHaveLength(1);
    controller.remove('b');
    queued[0]!();
    expect(sockets).toHaveLength(1);
  });
  it('does not reconnect or apply late card callbacks after removal', () => {
    const queued: Array<() => void> = [];
    const sockets: WebSocket[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      reconnectDelaysMs: [1],
      setTimeout: ((fn: () => void) => {
        queued.push(fn);
        return queued.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    const old = sockets[0]!;
    controller.remove('b');
    old.onclose?.({} as CloseEvent);
    old.onmessage?.({
      data: JSON.stringify({
        type: 'relay.event',
        event: { sequence: 1, type: 'agent.activity.updated', payload: snapshot('b', 'idle') },
      }),
    } as MessageEvent);
    queued.forEach((run) => run());
    expect(sockets).toHaveLength(1);
    expect(controller.get('b')).toBeNull();
  });
  it('stops reconnecting after its bounded delays and resets after a valid message', () => {
    const queued: Array<() => void> = [];
    const sockets: WebSocket[] = [];
    const controller = new AgentActivityController({
      relay: { getSession: async () => ({}), refreshActivity: async () => {} },
      publish: () => {},
      location: { protocol: 'http:', host: 'relay' } as Location,
      reconnectDelaysMs: [1],
      setTimeout: ((fn: () => void) => {
        queued.push(fn);
        return queued.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      websocket: () => {
        const socket = { close: () => {}, onmessage: null, onclose: null } as unknown as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    controller.sync(['a', 'b'], 'a');
    sockets[0]!.onclose?.({} as CloseEvent);
    queued[0]!();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onmessage?.({
      data: JSON.stringify({
        type: 'relay.event',
        event: { sequence: 1, type: 'agent.activity.updated', payload: snapshot('b') },
      }),
    } as MessageEvent);
    sockets[1]!.onclose?.({} as CloseEvent);
    expect(queued).toHaveLength(2);
    queued[1]!();
    sockets[2]!.onclose?.({} as CloseEvent);
    expect(queued).toHaveLength(2);
  });
});
