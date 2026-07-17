/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function relayStatePath(root: string, stateHome: string): string {
  return statePath(root, stateHome, 'gestalt-mobile');
}

export function legacyRelayStatePath(root: string, stateHome: string): string {
  return statePath(root, stateHome, 'codex-relay');
}

function statePath(root: string, stateHome: string, applicationName: string): string {
  return join(
    stateHome,
    applicationName,
    createHash('sha256').update(root).digest('hex').slice(0, 12),
    'relay.sqlite',
  );
}
