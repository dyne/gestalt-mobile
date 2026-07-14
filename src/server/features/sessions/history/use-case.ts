import type { SessionEvent } from '../../../../shared/contracts/session-event.js';
export function canonicalHistory(events: SessionEvent[]): SessionEvent[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}
