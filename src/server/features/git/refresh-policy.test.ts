/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mayFetch } from './refresh-policy.js';
describe('mayFetch', () => {
  it('throttles repeated fetches', () => {
    expect(mayFetch(1000, 2000)).toBe(false);
    expect(mayFetch(1000, 61000)).toBe(true);
  });
});
