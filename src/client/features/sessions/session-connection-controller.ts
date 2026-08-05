/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { reconnectDelay } from './session-state.js';

type Schedule = (callback: () => void, delay?: number) => ReturnType<typeof setTimeout>;
type CancelSchedule = (timer: ReturnType<typeof setTimeout>) => void;

export type SessionConnectionControllerOptions = Readonly<{
  selectedSessionId: () => string | null;
  cursor: () => number;
  onopen: () => void;
  onclose: () => void;
  onmessage: (data: string) => void;
  onreconcile: () => Promise<void>;
  websocket?: (url: string) => WebSocket;
  document?: Document;
  window?: Window;
  location?: Location;
  setTimeout?: Schedule;
  clearTimeout?: CancelSchedule;
}>;

/**
 * Owns the short-lived connection resources for the selected relay session.
 * Every callback is guarded by a generation, so a closed or replaced session
 * cannot publish a late socket, timer, or reconciliation result.
 */
export class SessionConnectionController {
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #reconnectAttempt = 0;
  #reconciling = false;
  #disposed = false;
  #sessionId: string | null = null;
  #options: Required<
    Pick<
      SessionConnectionControllerOptions,
      'websocket' | 'document' | 'window' | 'location' | 'setTimeout' | 'clearTimeout'
    >
  > &
    SessionConnectionControllerOptions;

  constructor(options: SessionConnectionControllerOptions) {
    this.#options = {
      ...options,
      websocket: options.websocket ?? ((url) => new WebSocket(url)),
      document: options.document ?? document,
      window: options.window ?? window,
      location: options.location ?? location,
      setTimeout:
        options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay)),
      clearTimeout: options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer)),
    };
  }

  start(): void {
    if (this.#disposed) return;
    this.#options.document.addEventListener('visibilitychange', this.#onForeground);
    this.#options.window.addEventListener('focus', this.#onForeground);
  }

  connect(sessionId: string): void {
    if (this.#disposed) return;
    this.#stopConnection();
    this.#sessionId = sessionId;
    this.#open(sessionId, ++this.#generation);
  }

  disconnect(): void {
    this.#sessionId = null;
    ++this.#generation;
    this.#stopConnection();
  }

  resync(): void {
    this.#resetFallback();
    void this.#reconcile();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.disconnect();
    this.#options.document.removeEventListener('visibilitychange', this.#onForeground);
    this.#options.window.removeEventListener('focus', this.#onForeground);
  }

  #onForeground = (): void => {
    if (this.#options.document.visibilityState !== 'visible') {
      this.#clearFallback();
      return;
    }
    this.#resetFallback();
    void this.#reconcile();
  };

  #isCurrent(sessionId: string, generation: number): boolean {
    return (
      !this.#disposed &&
      generation === this.#generation &&
      this.#sessionId === sessionId &&
      this.#options.selectedSessionId() === sessionId
    );
  }

  #open(sessionId: string, generation: number): void {
    if (!this.#isCurrent(sessionId, generation)) return;
    const protocol = this.#options.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.#options.websocket(
      `${protocol}//${this.#options.location.host}/api/sessions/${encodeURIComponent(sessionId)}/events?after=${this.#options.cursor()}`,
    );
    this.#socket = socket;
    socket.onopen = () => {
      if (!this.#isCurrent(sessionId, generation)) return;
      this.#options.onopen();
      this.#resetFallback();
      void this.#reconcile();
      this.#stableTimer = this.#options.setTimeout(() => {
        if (this.#isCurrent(sessionId, generation)) this.#reconnectAttempt = 0;
      }, 30_000);
    };
    socket.onmessage = (event) => {
      if (this.#isCurrent(sessionId, generation)) this.#options.onmessage(String(event.data));
    };
    socket.onclose = () => {
      if (!this.#isCurrent(sessionId, generation)) return;
      this.#options.onclose();
      this.#clearStableTimer();
      this.#reconnectTimer = this.#options.setTimeout(
        () => this.#open(sessionId, generation),
        reconnectDelay(this.#reconnectAttempt++),
      );
    };
  }

  async #reconcile(): Promise<void> {
    const sessionId = this.#sessionId;
    const generation = this.#generation;
    if (!sessionId || this.#reconciling || this.#options.document.visibilityState !== 'visible')
      return;
    this.#reconciling = true;
    try {
      await this.#options.onreconcile();
    } finally {
      if (this.#isCurrent(sessionId, generation)) this.#reconciling = false;
    }
  }

  #resetFallback(): void {
    this.#clearFallback();
    if (this.#options.document.visibilityState !== 'visible' || !this.#sessionId) return;
    const generation = this.#generation;
    this.#fallbackTimer = this.#options.setTimeout(() => {
      if (!this.#sessionId || generation !== this.#generation) return;
      void this.#reconcile();
      this.#resetFallback();
    }, 10_000);
  }

  #clearStableTimer(): void {
    if (!this.#stableTimer) return;
    this.#options.clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
  }

  #clearFallback(): void {
    if (!this.#fallbackTimer) return;
    this.#options.clearTimeout(this.#fallbackTimer);
    this.#fallbackTimer = null;
  }

  #stopConnection(): void {
    if (this.#reconnectTimer) this.#options.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#clearStableTimer();
    this.#clearFallback();
    this.#socket?.close();
    this.#socket = null;
  }
}
