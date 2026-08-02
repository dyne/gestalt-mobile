/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelayHistory, RestoreSessionResult } from './relay-client.js';

type HistoryRelay = {
  getHistory(sessionId: string): Promise<RelayHistory>;
  restoreSession(sessionId: string): Promise<RestoreSessionResult>;
};

export async function getHistoryWithRecovery(
  relay: HistoryRelay,
  sessionId: string,
): Promise<{ history: RelayHistory; restored: RestoreSessionResult | null }> {
  try {
    return { history: await relay.getHistory(sessionId), restored: null };
  } catch (error) {
    if (!hasProblemCode(error, 'SESSION_HISTORY_UNAVAILABLE')) throw error;
    const restored = await relay.restoreSession(sessionId);
    return { history: await relay.getHistory(sessionId), restored };
  }
}

function hasProblemCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
