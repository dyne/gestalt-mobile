/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { toGitSummary } from './git-summary.js';
describe('toGitSummary', () => {
  it('cannot push without an upstream', () =>
    expect(toGitSummary({ branch: 'main', upstream: null, ahead: 1, behind: 0 }).canPush).toBe(
      false,
    ));
});
