import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function listSessions(sessions: RelaySessionSnapshot[]): RelaySessionSnapshot[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
