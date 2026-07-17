/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class JsonRpcClient {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  private readonly notifications = new Set<
    (notification: { method: string; params: unknown }) => void
  >();
  private readonly serverRequests = new Set<
    (request: { id: number; method: string; params: unknown }) => Promise<unknown> | unknown
  >();
  private failure: unknown = null;
  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    createInterface({ input, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
  onNotification(
    listener: (notification: { method: string; params: unknown }) => void,
  ): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  onServerRequest(
    listener: (request: {
      id: number;
      method: string;
      params: unknown;
    }) => Promise<unknown> | unknown,
  ): () => void {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }
  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (message.id === undefined) {
        if (message.method)
          this.notifications.forEach((listener) =>
            listener({ method: message.method!, params: message.params }),
          );
        return;
      }
      if (message.method) {
        const listener = this.serverRequests.values().next().value as
          | ((request: {
              id: number;
              method: string;
              params: unknown;
            }) => Promise<unknown> | unknown)
          | undefined;
        if (!listener) return;
        void Promise.resolve(
          listener({ id: message.id, method: message.method, params: message.params }),
        )
          .then((result) =>
            this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`),
          )
          .catch((error: unknown) =>
            this.output.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { message: error instanceof Error ? error.message : 'REQUEST_FAILED' } })}\n`,
            ),
          );
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
    } catch {
      /* malformed protocol messages are ignored at this boundary */
    }
  }
}
