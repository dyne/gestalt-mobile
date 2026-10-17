/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionEvent } from '../../../shared/contracts/session-event.js';
export type SessionReplay =
  { kind: 'replay'; events: SessionEvent[] } | { kind: 'resync'; currentSequence: number };

export function replayOrResync(events: SessionEvent[], after: number): SessionReplay {
  if (!events.length) return { kind: 'replay', events: [] };
  return events[0]!.sequence > after + 1
    ? { kind: 'resync', currentSequence: events.at(-1)!.sequence }
    : { kind: 'replay', events: events.filter((event) => event.sequence > after) };
}
