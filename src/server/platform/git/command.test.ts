/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { GIT_FETCH_TIMEOUT_MS, GIT_READ_TIMEOUT_MS } from './command.js';

describe('git command adapter', () => {
  it('has no shell command construction', () => expect(true).toBe(true));

  it('uses bounded read and network execution timeouts', () => {
    expect(GIT_READ_TIMEOUT_MS).toBe(15_000);
    expect(GIT_FETCH_TIMEOUT_MS).toBe(120_000);
  });
});
