/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionEvent } from '../../../../shared/contracts/session-event.js';
export function canonicalHistory(events: SessionEvent[]): SessionEvent[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}
