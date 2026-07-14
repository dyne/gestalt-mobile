import type { SessionEvent } from '../../../shared/contracts/session-event.js';
export function replayOrResync(
  events: SessionEvent[],
  after: number,
): { kind: 'replay'; events: SessionEvent[] } | { kind: 'resync' } {
  if (!events.length) return { kind: 'replay', events: [] };
  return events[0]!.sequence > after + 1
    ? { kind: 'resync' }
    : { kind: 'replay', events: events.filter((event) => event.sequence > after) };
}
