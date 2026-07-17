/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { isInteractionKind } from './kind.js';
describe('isInteractionKind', () => {
  it('recognizes every mobile-interactive Codex request class', () =>
    expect(isInteractionKind('userInput')).toBe(true));
});
