/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RelaySession } from '../model/relay-session.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function release(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  return RelaySession.rehydrate(session).release(now).snapshot;
}
