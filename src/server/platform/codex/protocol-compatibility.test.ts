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

  it('accepts compatible newer minor and patch versions', () => {
    expect(protocolCompatibility('codex-cli 0.146.2', 'codex-cli 0.144.5')).toEqual({ compatible: true });
    expect(protocolCompatibility('codex-cli 1.0.0', 'codex-cli 0.144.5')).toEqual({
      compatible: false,
      code: 'CODEX_PROTOCOL_MISMATCH',
    });
  });

  it('fails closed for unrelated pre-1.0, invalid, and major versions', () => {
    for (const installed of ['codex-cli 0.1.99', 'codex-cli 0.149.0', 'unknown', 'codex-cli 1.0.0'])
      expect(protocolCompatibility(installed, 'codex-cli 0.144.5')).toMatchObject({ compatible: false, code: 'CODEX_PROTOCOL_MISMATCH' });
  });
});
