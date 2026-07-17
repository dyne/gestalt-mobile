/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type RelaySessionEvent = {
  type:
    | 'ThreadBound'
    | 'TurnStarted'
    | 'TurnCompleted'
    | 'InteractionRequested'
    | 'InteractionResolved'
    | 'RecoveryBegan'
    | 'SessionRestored'
    | 'AttentionRequired'
    | 'SessionStopped'
    | 'SessionReleased';
  occurredAt: string;
  sessionId: string;
};
