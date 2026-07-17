/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { canSubmitInteraction } from './interaction-state.js';
describe('canSubmitInteraction', () => {
  it('prevents duplicate approval submissions', () => {
    expect(canSubmitInteraction('pending')).toBe(true);
    expect(canSubmitInteraction('submitting')).toBe(false);
    expect(canSubmitInteraction('resolved')).toBe(false);
  });
});
