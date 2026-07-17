/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { installWebSocketHeartbeat } from './websocket-heartbeat.js';

describe('installWebSocketHeartbeat', () => {
  it('pings an active client and terminates it after a missed pong', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const socket = {
      ping: vi.fn(),
      terminate: vi.fn(),
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    installWebSocketHeartbeat(socket, 25_000);

    vi.advanceTimersByTime(25_000);
    expect(socket.ping).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25_000);
    expect(socket.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('keeps a client alive after it replies with pong', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const socket = {
      ping: vi.fn(),
      terminate: vi.fn(),
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    installWebSocketHeartbeat(socket, 25_000);

    vi.advanceTimersByTime(25_000);
    listeners.get('pong')?.();
    vi.advanceTimersByTime(25_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
