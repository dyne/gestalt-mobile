/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../model/relay-session.js';

/** Evidence of confirmed process shutdown, invalidated before every new runtime. */
export interface RuntimeReleaseStore {
  confirmed(session: RelaySessionSnapshot): boolean;
  confirm(session: RelaySessionSnapshot): void;
  invalidate(sessionId: string): void;
}
