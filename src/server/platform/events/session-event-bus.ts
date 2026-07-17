/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionEvent } from '../../../shared/contracts/session-event.js';
export class SessionEventBus {
  private readonly listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  publish(event: SessionEvent): void {
    this.listeners.get(event.sessionId)?.forEach((listener) => listener(event));
  }
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }
}
