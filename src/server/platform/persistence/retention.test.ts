/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { eventRetention, retainedSequences } from './retention.js';
describe('retainedSequences', () => {
  it('keeps the newest 2,000 events', () =>
    expect(
      retainedSequences(Array.from({ length: eventRetention + 1 }, (_, index) => index)).length,
    ).toBe(eventRetention));
});
