/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { idempotencyKey } from './idempotency.js';
describe('idempotencyKey', () => {
  it('requires a nonblank header', () => {
    expect(idempotencyKey({ 'idempotency-key': ' k ' })).toBe(' k ');
    expect(idempotencyKey({})).toBeNull();
  });
});
