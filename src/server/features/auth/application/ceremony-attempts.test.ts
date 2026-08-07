/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { ExpiringCeremonyAttemptGate } from './ceremony-attempts.js';
describe('ExpiringCeremonyAttemptGate', () => {
  it('bounds attempts and resets after its expiry window', () => {
    const gate = new ExpiringCeremonyAttemptGate(2, 1_000);
    const now = new Date('2026-08-01T00:00:00.000Z');
    expect(gate.allow('login:opaque', now)).toBe(true);
    expect(gate.allow('login:opaque', now)).toBe(true);
    expect(gate.allow('login:opaque', now)).toBe(false);
    expect(gate.allow('login:opaque', new Date(now.getTime() + 1_000))).toBe(true);
  });
});
