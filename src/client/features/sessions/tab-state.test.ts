/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { nextTab } from './tab-state.js';
describe('nextTab', () => {
  it('wraps keyboard tab navigation', () => expect(nextTab('chat', -1)).toBe('sessions'));
});
