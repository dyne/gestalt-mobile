/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatViewState } from './chat-controller.js';

class Socket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}
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
    expect(history).toHaveBeenCalledWith('a');
    expect(history).toHaveBeenCalledWith('b');
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
  it('recovers from a websocket factory throw without an unhandled rejection', async () => {
    const env = environment();
    const timers: Array<() => void> = [];
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
        return new Socket() as unknown as WebSocket;
      },
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    controller.select('s');
    await Promise.resolve();
    expect(timers).toHaveLength(1);
    timers[0]?.();
    expect(calls).toBe(2);
    controller.dispose();
  });
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
    expect(reply).toHaveBeenNthCalledWith(1, 's', 'a', 'approved', 'ka');
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
});
