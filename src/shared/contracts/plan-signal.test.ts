/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { isPlanSignalReason } from './plan-signal.js';

describe('plan status signal reason', () => {
  it('preserves bounded L2 transition identities for checkpoint selection', () => {
    expect(isPlanSignalReason('l2:patch-browser-assets:DONE')).toBe(true);
    expect(isPlanSignalReason('l2:patch-browser-assets:WIP')).toBe(true);
    expect(isPlanSignalReason('l2:patch-browser-assets:TODO')).toBe(false);
    expect(isPlanSignalReason(`l2:${'x'.repeat(129)}:DONE`)).toBe(false);
    expect(isPlanSignalReason('l2::DONE')).toBe(false);
  });
  it('accepts bounded durable REVIEWED transition evidence', () => {
    expect(isPlanSignalReason('review:implementation-l1:REVIEWED')).toBe(true);
    expect(isPlanSignalReason('review:implementation-l1:UNREVIEWED')).toBe(false);
    expect(isPlanSignalReason(`review:${'x'.repeat(129)}:REVIEWED`)).toBe(false);
  });
});
