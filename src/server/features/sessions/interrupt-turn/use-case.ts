import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function interruptTurn(
  session: RelaySessionSnapshot,
  turnId: string,
): { accepted: boolean; code?: string } {
  return session.activeTurnId === turnId
    ? { accepted: true }
    : { accepted: false, code: 'TURN_NOT_ACTIVE' };
}
