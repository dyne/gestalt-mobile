/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export interface CeremonyAttemptGate { allow(key: string, now: Date): boolean; }
/** Process-local by design: the relay's authorization database is local state. */
export class ExpiringCeremonyAttemptGate implements CeremonyAttemptGate {
  #attempts = new Map<string, { count: number; expires: number }>();
  constructor(private readonly limit = 8, private readonly windowMs = 10 * 60 * 1000) {}
  allow(key: string, now: Date): boolean {
    const old = this.#attempts.get(key); const expires = now.getTime() + this.windowMs;
    if (!old || old.expires <= now.getTime()) { this.#attempts.set(key, { count: 1, expires }); return true; }
    if (old.count >= this.limit) return false;
    old.count++; return true;
  }
}
