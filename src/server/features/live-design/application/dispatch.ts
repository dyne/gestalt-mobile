/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

export class LiveDispatchError extends Error {
  readonly code: string;
  constructor(code = 'LIVE_MODE_ACTIVE') {
    super(code);
    this.code = code;
  }
}
/** Controller-owned policy; callers cannot assert Live authority using request JSON. */
export interface LiveDispatchPolicy {
  check(session: RelaySessionSnapshot): void;
  /** Reserve before every writer/process effect and recheck at the last outbound boundary. */
  writer(session: RelaySessionSnapshot, kind?: 'writer' | 'turn' | 'executor'): void;
  /** Only current controller-minted Live event authority can answer a Live interaction. */
  interaction(sessionId: string): void;
  blocked(sessionId: string): boolean;
}
