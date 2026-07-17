/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mayStartTurn } from './start-policy.js';
describe('mayStartTurn', () => {
  it('prevents blank or concurrent turns', () => {
    expect(mayStartTurn('ready', ' ')).toBe(false);
    expect(mayStartTurn('turnActive', 'hello')).toBe(false);
  });
});
