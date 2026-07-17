/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { recoveryDelay } from './retry-policy.js';

export class SessionSupervisor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly restore: (sessionId: string) => Promise<void>,
    private readonly requireAttention: (sessionId: string) => void,
  ) {}

  recover(sessionId: string, failureCount = 0): void {
    this.cancel(sessionId);
    void this.attempt(sessionId, failureCount);
  }

  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private async attempt(sessionId: string, failureCount: number): Promise<void> {
    try {
      await this.restore(sessionId);
    } catch {
      const delay = recoveryDelay(failureCount);
      if (delay === null) {
        this.requireAttention(sessionId);
        return;
      }
      this.timers.set(
        sessionId,
        setTimeout(() => {
          this.timers.delete(sessionId);
          void this.attempt(sessionId, failureCount + 1);
        }, delay),
      );
    }
  }
}
