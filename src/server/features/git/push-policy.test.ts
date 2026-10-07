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
  it('allows first publication only with a local branch and origin', () => {
    expect(
      mayPush({ branch: 'topic', originUrl: '/remote', upstream: null, ahead: 0, behind: 0 }),
    ).toEqual({ allowed: true });
    expect(mayPush({ branch: 'topic', upstream: null, ahead: 0, behind: 0 }).reason).toBe(
      'NO_ORIGIN',
    );
    expect(
      mayPush({ branch: null, originUrl: '/remote', upstream: null, ahead: 0, behind: 0 }).reason,
    ).toBe('NO_BRANCH');
  });
});
