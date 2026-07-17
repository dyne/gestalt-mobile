/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { ageLabel, relativeTime } from './relative-time.js';
describe('ageLabel', () => {
  it('labels cached Git state age', () => expect(ageLabel(120_000)).toBe('2m ago'));
});

describe('relativeTime', () => {
  it('uses a human relative label for commit timestamps', () => {
    expect(relativeTime('2026-07-18T10:00:00.000Z', Date.parse('2026-07-20T10:00:00.000Z'))).toBe(
      '2 days ago',
    );
  });
});
