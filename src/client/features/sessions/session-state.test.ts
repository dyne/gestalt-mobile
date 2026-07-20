/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { reconnectDelay, turnReadiness } from './session-state.js';
describe('reconnectDelay', () => {
  it('caps flaky-connection retry delay', () => expect(reconnectDelay(99, () => 0.5)).toBe(10000));
});

describe('turnReadiness', () => {
  it('tells the user when Codex is working or ready for the next instruction', () => {
    expect(turnReadiness('turn-1')).toBe('Codex is working…');
    expect(turnReadiness(null)).toBe('Ready.');
  });
});
