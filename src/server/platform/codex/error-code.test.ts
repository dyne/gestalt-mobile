/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { protocolErrorCode } from './error-code.js';
describe('protocolErrorCode', () => {
  it('uses a stable missing-Codex code', () =>
    expect(protocolErrorCode(null)).toBe('CODEX_NOT_FOUND'));
  it('does not reject an installed CLI based on version text', () =>
    expect(protocolErrorCode('codex-cli 999.0.0')).toBeNull());
});
