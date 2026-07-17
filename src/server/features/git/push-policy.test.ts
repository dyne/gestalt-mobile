/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mayPush } from './push-policy.js';
describe('mayPush', () => {
  it('prevents push while behind upstream', () =>
    expect(mayPush({ upstream: 'origin/main', ahead: 1, behind: 1 })).toEqual({
      allowed: false,
      reason: 'BEHIND_UPSTREAM',
    }));
});
