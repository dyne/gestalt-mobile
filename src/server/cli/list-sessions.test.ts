/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { formatSessions } from './list-sessions.js';
describe('formatSessions', () => {
  it('handles no persisted sessions', () => expect(formatSessions([])).toBe('No sessions\n'));
});
