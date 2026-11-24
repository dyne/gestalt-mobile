/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const resetCreditCooldownMs = 10 * 60_000;
const providerTimeoutMs = 10_000;

export type WeeklyResetCandidate = { creditId: string; weeklyResetsAt: number };

export interface CodexResetStore {
  enabled(): boolean;
  claim(id: string, now: number, weeklyResetsAt: number): boolean;
  recordReset(id: string, occurredAt: number): void;
}

export type WeeklyResetAccount = {
  readCandidate(now: number): Promise<WeeklyResetCandidate | null>;
  redeem(creditId: string, idempotencyKey: string): Promise<boolean>;
};

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('CODEX_RESET_CREDIT_TIMED_OUT')),
          providerTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class CodexAutoReset {
  private checking = false;
  constructor(
    private readonly store: CodexResetStore,
    private readonly createId: () => string,
    private readonly now = Date.now,
  ) {}

  async blocked(account: WeeklyResetAccount): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!this.store.enabled()) return;
      const candidate = await bounded(account.readCandidate(this.now()));
      if (!candidate) return;
      const now = this.now();
      const id = this.createId();
      if (
        candidate.weeklyResetsAt * 1000 <= now + 60_000 ||
        !this.store.claim(id, now, candidate.weeklyResetsAt)
      )
        return;
      if (await bounded(account.redeem(candidate.creditId, id)))
        this.store.recordReset(id, this.now());
    } catch {
      // An unconfirmed redemption keeps its durable claim. Never spend another
      // credit to retry this window or retain opaque provider diagnostics.
    } finally {
      this.checking = false;
    }
  }
}
