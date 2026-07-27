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
    expect(nextTab('chat', 1)).toBe('sessions');
    expect(nextTab('sessions', -1)).toBe('chat');
  });

  it('skips Chat when no session is open', () => {
    expect(nextTab('sessions', 1, false)).toBe('git');
    expect(nextTab('git', 1, false)).toBe('sessions');
  });
});
