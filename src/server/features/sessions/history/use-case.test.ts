/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { canonicalHistory } from './use-case.js';
describe('canonicalHistory', () => {
  it('orders replay history by durable sequence', () =>
    expect(
      canonicalHistory([
        { sessionId: 's', sequence: 2, type: 'x', occurredAt: 't', payload: {} },
        { sessionId: 's', sequence: 1, type: 'x', occurredAt: 't', payload: {} },
      ]).map((event) => event.sequence),
    ).toEqual([1, 2]));
});
