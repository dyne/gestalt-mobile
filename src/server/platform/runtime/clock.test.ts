/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';
describe('systemClock', () => {
  it('provides a numeric current time', () =>
    expect(systemClock.now()).toEqual(expect.any(Number)));
});
