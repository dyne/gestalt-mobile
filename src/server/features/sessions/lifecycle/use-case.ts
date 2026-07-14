import { RelaySession } from '../model/relay-session.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function stopSession(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  return RelaySession.rehydrate(session).stop(now).snapshot;
}
export function releaseSession(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  return RelaySession.rehydrate(session).release(now).snapshot;
}
export function restoreSession(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  return RelaySession.rehydrate(session).beginRecovery(now).restore(now).snapshot;
}
