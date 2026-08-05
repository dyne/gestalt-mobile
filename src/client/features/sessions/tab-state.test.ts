/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { nextTab } from './tab-state.js';
describe('nextTab', () => {
  it('follows the visible tab order', () => {
    expect(nextTab('sessions', 1)).toBe('git');
    expect(nextTab('git', 1)).toBe('chat');
    expect(nextTab('chat', 1)).toBe('plan');
    expect(nextTab('sessions', -1)).toBe('plan');
  });

  it('skips Chat when no session is open', () => {
    expect(nextTab('sessions', 1, { chatEnabled: false })).toBe('git');
    expect(nextTab('git', 1, { chatEnabled: false })).toBe('plan');
  });

  it('places Plan immediately after Chat and keeps it reachable without Chat', () => {
    const capabilities = { chatEnabled: true };
    expect(nextTab('chat', 1, capabilities)).toBe('plan');
    expect(nextTab('plan', 1, capabilities)).toBe('sessions');
    expect(nextTab('sessions', -1, capabilities)).toBe('plan');
    expect(nextTab('plan', 1, { chatEnabled: false })).toBe('sessions');
  });
});
