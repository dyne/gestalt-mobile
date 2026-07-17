/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { replayOrResync } from './replay.js';
describe('replayOrResync', () => {
  it('requests canonical resync across a pruned gap', () =>
    expect(
      replayOrResync([{ sessionId: 's', sequence: 5, type: 'x', occurredAt: 't', payload: {} }], 1),
    ).toEqual({ kind: 'resync' }));
});
