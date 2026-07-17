/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { legacyRelayStatePath, relayStatePath } from './state-path.js';
describe('relayStatePath', () => {
  it('isolates state by relay root', () =>
    expect(relayStatePath('/a', '/state')).not.toBe(relayStatePath('/b', '/state')));

  it('uses the new application name without changing the legacy location', () => {
    expect(relayStatePath('/a', '/state')).toContain('/gestalt-mobile/');
    expect(legacyRelayStatePath('/a', '/state')).toContain('/codex-relay/');
  });
});
