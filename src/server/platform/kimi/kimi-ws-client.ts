/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import WebSocket from 'ws';

import { boundMessage } from './kimi-errors.js';

/** One kimi web event frame as delivered on `/api/v1/ws`. */
export type KimiWsEvent = {
  type: string;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  session_id?: string;
  timestamp?: string;
  payload?: unknown;
};

export type KimiWsAck = { type: 'ack'; id?: string; code: number; msg?: string };

/**
 * WebSocket client for the kimi web Server API. Client frames carry a
 * monotonically increasing id and are acknowledged with `{type:'ack'}`;
 * session events arrive as `session_event` frames. Durable missed events are
 * replayed by the server when `subscribe` carries per-session cursors.
 */
export class KimiWsClient {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private readonly pending = new Map<
    string,
    { resolve(ack: KimiWsAck): void; reject(reason: unknown): void }
  >();
  private readonly eventListeners = new Set<(event: KimiWsEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((reason: unknown) => void) | null = null;

  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  public connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/api/v1/ws`, [`kimi-code.bearer.${this.token}`]);
    this.socket = socket;
    socket.on('message', (data) => this.onMessage(data));
    socket.on('close', () => this.onSocketClosed());
    socket.on('error', () => {
      /* surface errors through connect() or the pending acks only */
    });
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      socket.once('open', () => {
        this.send({ type: 'client_hello', payload: { client_id: 'gestalt-mobile' } });
      });
      // `server_hello` resolves connect(); guard against a silent hang.
      setTimeout(() => {
        if (this.connectReject) {
          const reject = this.connectReject;
          this.connectReject = null;
          reject(new Error('timed out waiting for kimi web server_hello'));
        }
      }, 10_000).unref();
    });
  }

  public onEvent(listener: (event: KimiWsEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public subscribe(
    sessionIds: string[],
    cursors?: Record<string, { seq: number }>,
  ): Promise<KimiWsAck> {
    return this.request('subscribe', { session_ids: sessionIds, ...(cursors ? { cursors } : {}) });
  }

  public unsubscribe(sessionIds: string[]): Promise<KimiWsAck> {
    return this.request('unsubscribe', { session_ids: sessionIds });
  }

  public abort(sessionId: string, promptId: string): Promise<KimiWsAck> {
    return this.request('abort', { session_id: sessionId, prompt_id: promptId });
  }

  public close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    this.failPending(new Error('kimi web socket closed'));
  }

  private request(type: string, payload: unknown): Promise<KimiWsAck> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`kimi web socket is not open (frame ${type})`));
    }
    const id = `g${++this.sequence}`;
    return new Promise<KimiWsAck>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type, id, payload });
    });
  }

  private send(frame: { type: string; id?: string; payload?: unknown }): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private onMessage(data: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame.type === 'server_hello') {
      const resolve = this.connectResolve;
      this.connectResolve = null;
      this.connectReject = null;
      resolve?.();
      return;
    }
    if (frame.type === 'ack') {
      const id = typeof frame.id === 'string' ? frame.id : undefined;
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) {
        this.pending.delete(id as string);
        const ack: KimiWsAck = {
          type: 'ack',
          id,
          code: typeof frame.code === 'number' ? frame.code : -1,
          ...(typeof frame.msg === 'string' ? { msg: boundMessage(frame.msg) } : {}),
        };
        pending.resolve(ack);
      }
      return;
    }
    if (frame.type === 'session_event') {
      const event = frame as unknown as KimiWsEvent;
      for (const listener of this.eventListeners) listener(event);
    }
  }

  private onSocketClosed(): void {
    this.socket = null;
    const reject = this.connectReject;
    this.connectReject = null;
    this.connectResolve = null;
    reject?.(new Error('kimi web socket closed before server_hello'));
    this.failPending(new Error('kimi web socket closed'));
    for (const listener of this.closeListeners) listener();
  }

  private failPending(reason: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(reason);
  }
}
