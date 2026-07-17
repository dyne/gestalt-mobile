/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { ageLabel } from './relative-time.js';
describe('ageLabel', () => {
  it('labels cached Git state age', () => expect(ageLabel(120_000)).toBe('2m ago'));
});
