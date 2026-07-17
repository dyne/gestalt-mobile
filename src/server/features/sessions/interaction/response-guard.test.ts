/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mayResolveInteraction } from './response-guard.js';
describe('mayResolveInteraction', () => {
  it('prevents duplicate approval and question answers', () => {
    expect(mayResolveInteraction(null)).toBe(true);
    expect(mayResolveInteraction('t')).toBe(false);
  });
});
