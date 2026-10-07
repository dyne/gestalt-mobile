/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { pushState } from './push-state.js';
describe('pushState', () => {
  it('explains unavailable Push without a branch', () =>
    expect(pushState({ upstream: null, ahead: 2 })).toEqual({
      enabled: false,
      reason: 'Select a local branch to push.',
    }));
  it('allows publishing a branch to origin without an upstream', () => {
    expect(
      pushState({
        branch: 'topic',
        originUrl: 'git@example.com:repo.git',
        upstream: null,
        ahead: 0,
      }).enabled,
    ).toBe(true);
  });
  it('explains missing origin and divergence', () => {
    expect(pushState({ branch: 'topic', upstream: null, ahead: 0 }).reason).toContain('No origin');
    expect(
      pushState({ branch: 'topic', upstream: 'origin/topic', ahead: 1, behind: 1 }).reason,
    ).toContain('Pull');
    expect(pushState({ branch: 'topic', upstream: 'origin/topic', ahead: 0 }).enabled).toBe(false);
  });
});
