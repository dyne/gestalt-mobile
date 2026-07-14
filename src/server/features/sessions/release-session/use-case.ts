import { RelaySession } from '../model/relay-session.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function release(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  return RelaySession.rehydrate(session).release(now).snapshot;
}
