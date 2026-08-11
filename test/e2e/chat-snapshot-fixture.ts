/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ChatSnapshot } from '../../src/shared/contracts/chat-snapshot.js';

/** Produces the complete, authoritative Chat history contract used by E2E routes. */
export function chatSnapshot({
  baseSequence = 0,
  currentSequence = baseSequence,
  activeTurnId = null,
  items = [],
  turns = [],
  interactions = [],
}: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return { baseSequence, currentSequence, activeTurnId, items, turns, interactions };
}
