/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import type { OwnedPreviewConnection, PreviewConnectionPermit } from './preview-connections.js';

/** Create before connecting upstream; cancellation must include any pending connection/request. */
export function ownedPreviewHttp(
  response: ServerResponse,
  cancelUpstream: () => void,
): OwnedPreviewConnection {
  return {
    close: () =>
      new Promise<void>((resolve) => {
        const socket = response.socket;
        const closed = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          socket?.destroy();
          closed();
        }, 2000);
        timer.unref();
        response.once('close', closed);
        // Abort rather than flushing buffered app chunks after the revocation barrier.
        response.destroy();
        cancelUpstream();
        if (response.closed) closed();
      }),
  };
}
export function relayPreviewHttpBody(
  permit: PreviewConnectionPermit,
  upstream: Readable,
  response: ServerResponse,
): void {
  upstream.on('data', (chunk) => {
    if (response.destroyed || response.writableEnded) {
      permit.release();
      upstream.destroy();
      return;
    }
    if (!permit.active()) return;
    if (!response.write(chunk)) upstream.pause();
  });
  response.on('drain', () => {
    if (permit.active()) upstream.resume();
  });
  upstream.once('end', () => {
    if (permit.active()) response.end();
  });
  upstream.once('error', () => response.destroy());
  response.once('close', () => {
    permit.release();
    upstream.destroy();
  });
}

/** Binding a stale callback cannot reopen a revoked HMR transport. */
export class OwnedPreviewWebSockets implements OwnedPreviewConnection {
  private revoked = false;
  private readonly peers = new Set<WebSocket>();
  constructor(private readonly cancelPending: () => void) {}
  bind(socket: WebSocket): void {
    if (this.revoked) {
      socket.on('error', () => {});
      socket.terminate();
      return;
    }
    this.peers.add(socket);
    socket.once('close', () => this.peers.delete(socket));
  }
  async close(): Promise<void> {
    this.revoked = true;
    const peers = [...this.peers];
    const pending = peers.map((socket) => closeWebSocket(socket));
    this.cancelPending();
    await Promise.all(pending);
  }
}
export function relayPreviewWebSockets(
  permit: PreviewConnectionPermit,
  client: WebSocket,
  upstream: WebSocket,
): void {
  for (const [source, destination] of [
    [client, upstream],
    [upstream, client],
  ] as const) {
    source.on('message', (data, binary) => {
      if (permit.active() && destination.readyState === WebSocket.OPEN)
        destination.send(data, { binary });
    });
    source.once('close', () => {
      permit.release();
      destination.close();
    });
    source.once('error', () => {
      permit.release();
      destination.terminate();
    });
  }
}
function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      closed();
    }, 2000);
    timer.unref();
    socket.once('close', closed);
    socket.on('error', () => {});
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'Live authorization revoked');
  });
}
