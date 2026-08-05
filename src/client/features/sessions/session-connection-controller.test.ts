/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionConnectionController } from './session-connection-controller.js';

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}

describe('SessionConnectionController', () => {
  afterEach(() => vi.useRealTimers());

  it('pauses fallback work while hidden, refreshes when foregrounded, and ignores disposal', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const reconcile = vi.fn(async () => undefined);
    let selected = 'session-1';
    let visibility: DocumentVisibilityState = 'visible';
    const fakeDocument = new EventTarget() as unknown as Document;
    const fakeWindow = new EventTarget() as unknown as Window;
    Object.defineProperty(fakeDocument, 'visibilityState', { get: () => visibility });
    const controller = new SessionConnectionController({
      selectedSessionId: () => selected,
      cursor: () => 3,
      onopen: vi.fn(),
      onclose: vi.fn(),
      onmessage: vi.fn(),
      onreconcile: reconcile,
      websocket: () => socket as unknown as WebSocket,
      document: fakeDocument,
      window: fakeWindow,
      location: { protocol: 'http:', host: 'relay.test' } as Location,
    });

    controller.start();
    controller.connect('session-1');
    socket.onopen?.();
    await vi.runAllTicks();
    expect(reconcile).toHaveBeenCalledTimes(1);

    visibility = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    visibility = 'visible';
    fakeWindow.dispatchEvent(new Event('focus'));
    await vi.runAllTicks();
    expect(reconcile).toHaveBeenCalledTimes(2);

    controller.dispose();
    selected = 'session-2';
    socket.onmessage?.(new MessageEvent('message', { data: 'late' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('does not publish a stale socket after a rapid session switch', () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const received = vi.fn();
    let selected = 'first';
    const sockets = [first, second];
    const controller = new SessionConnectionController({
      selectedSessionId: () => selected,
      cursor: () => 0,
      onopen: vi.fn(),
      onclose: vi.fn(),
      onmessage: received,
      onreconcile: async () => undefined,
      websocket: () => sockets.shift() as unknown as WebSocket,
      document: {
        visibilityState: 'visible',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Document,
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Window,
      location: { protocol: 'http:', host: 'relay.test' } as Location,
    });
    controller.connect('first');
    selected = 'second';
    controller.connect('second');
    first.onmessage?.(new MessageEvent('message', { data: 'stale' }));
    second.onmessage?.(new MessageEvent('message', { data: 'current' }));
    expect(received).toHaveBeenCalledExactlyOnceWith('current');
  });
});
