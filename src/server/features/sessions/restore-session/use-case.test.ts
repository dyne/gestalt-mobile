/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { canRestore } from './use-case.js';
describe('canRestore', () => {
  it('requires a persisted thread and no active turn', () => {
    expect(canRestore({ threadId: null, state: 'ready' } as never)).toBe(false);
    expect(canRestore({ threadId: 't', state: 'turnActive' } as never)).toBe(false);
  });

  it('rejects an already relay-owned ready session', () => {
    expect(canRestore({ threadId: 't', state: 'ready' } as never)).toBe(false);
  });

  it('allows an inactive persisted session to be reclaimed', () => {
    expect(canRestore({ threadId: 't', state: 'released' } as never)).toBe(true);
    expect(canRestore({ threadId: 't', state: 'stopped' } as never)).toBe(true);
  });
});
