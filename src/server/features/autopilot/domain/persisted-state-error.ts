/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** An existing invalid controller must not masquerade as an absent one. No persisted content. */
export class AutopilotStateError extends Error {
  readonly code = 'AUTOPILOT_STATE_INVALID';
  constructor(readonly sessionId: string) {
    super('AUTOPILOT_STATE_INVALID');
  }
}
