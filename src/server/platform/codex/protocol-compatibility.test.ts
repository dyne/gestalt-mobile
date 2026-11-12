/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { protocolCompatibility } from './protocol-compatibility.js';

describe('protocolCompatibility', () => {
  it.each([
    'codex-cli 0.1.99',
    'codex-cli 0.144.3',
    'codex-cli 0.167.0',
    'codex-cli 1.0.0',
    'codex-cli 999.42.0',
    'custom development build',
  ])('admits installed Codex %s without a version policy', (version) => {
    expect(protocolCompatibility(version)).toEqual({ compatible: true });
  });
  it('reports a missing CLI separately from runtime operation failures', () => {
    expect(protocolCompatibility(null)).toEqual({ compatible: false, code: 'CODEX_NOT_FOUND' });
  });
});
