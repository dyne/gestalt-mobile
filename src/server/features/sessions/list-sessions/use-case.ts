/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function listSessions(sessions: RelaySessionSnapshot[]): RelaySessionSnapshot[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
