/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
import type { FollowTailReason } from './chat-follow-tail.js';
export class ChatTailScheduler {
  #generation = 0;
  constructor(
    private readonly afterCommit: (fn: () => void) => void,
    private readonly request: (reason: FollowTailReason) => void,
  ) {}
  schedule(reason: FollowTailReason): void {
    const token = this.#generation;
    this.afterCommit(() => {
      if (token === this.#generation) this.request(reason);
    });
  }
  invalidate(): void {
    this.#generation += 1;
  }
}
