/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { protocolCompatibility } from './protocol-compatibility.js';

describe('protocolCompatibility', () => {
  it('reports a stable mismatch code', () => {
    expect(protocolCompatibility('codex-cli 1', 'codex-cli 2')).toEqual({
      compatible: false,
      code: 'CODEX_PROTOCOL_MISMATCH',
    });
  });
});
