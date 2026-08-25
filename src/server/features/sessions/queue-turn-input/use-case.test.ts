/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { queueTurnInput } from './use-case.js';

describe('queueTurnInput', () => {
  it('only targets the currently active turn', () => {
    expect(queueTurnInput({ activeTurnId: 'turn-1' } as never, 'turn-1')).toEqual({
      accepted: true,
    });
    expect(queueTurnInput({ activeTurnId: 'turn-1' } as never, 'turn-2')).toEqual({
      accepted: false,
      code: 'TURN_NOT_ACTIVE',
    });
  });
});
