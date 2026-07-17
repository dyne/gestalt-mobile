/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { listSessions } from './use-case.js';
describe('listSessions', () => {
  it('shows most recently updated sessions first', () =>
    expect(
      listSessions([{ updatedAt: 'a' }, { updatedAt: 'b' }] as never).map(
        (session) => session.updatedAt,
      ),
    ).toEqual(['b', 'a']));
});
