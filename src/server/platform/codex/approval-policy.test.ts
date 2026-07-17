/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { requiresApproval } from './approval-policy.js';
describe('requiresApproval', () => {
  it('preserves user approval requests unless policy is never', () => {
    expect(requiresApproval('on-request', true)).toBe(true);
    expect(requiresApproval('never', true)).toBe(false);
  });
});
