/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Owns only process-local acknowledgement deadlines, never durable attention. */
export class AttentionAcknowledgement {
  private readonly timers = new Map<string, { cancel(): void; token: symbol }>();

  constructor(
    private readonly ports: {
      schedule(callback: () => void, delayMs: number): () => void;
      recoverWriter(sessionId: string, requestId: string): void;
      deadlineMs: number;
    },
  ) {}

  arm(sessionId: string, requestId: string): void {
    this.responseSettled(sessionId, requestId);
    const key = `${sessionId}:${requestId}`;
    const token = Symbol(key);
    const cancel = this.ports.schedule(() => {
      if (this.timers.get(key)?.token !== token) return;
      this.timers.delete(key);
      this.ports.recoverWriter(sessionId, requestId);
    }, this.ports.deadlineMs);
    this.timers.set(key, { cancel, token });
  }

  /** Every transport settlement releases the acknowledgement deadline. */
  responseSettled(sessionId: string, requestId: string): boolean {
    const key = `${sessionId}:${requestId}`;
    const timer = this.timers.get(key);
    if (!timer) return false;
    timer.cancel();
    this.timers.delete(key);
    return true;
  }

  disposeSession(sessionId: string): void {
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      timer.cancel();
      this.timers.delete(key);
    }
  }
}
