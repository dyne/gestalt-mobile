import type { RelaySessionSnapshot, PendingInteraction } from '../model/relay-session.js';
import type { SessionEvent } from '../../../../shared/contracts/session-event.js';
export interface SessionRepository {
  save(session: RelaySessionSnapshot): void;
  find(id: string): RelaySessionSnapshot | null;
  list(): RelaySessionSnapshot[];
}
export interface PendingInteractionStore {
  add(sessionId: string, interaction: PendingInteraction): void;
  resolve(sessionId: string, requestId: string, resolvedAt: string): boolean;
}
export interface SessionEventJournal {
  append(sessionId: string, type: string, payload: unknown, occurredAt: string): SessionEvent;
  since(sessionId: string, after: number): SessionEvent[];
}
export interface IdempotencyStore {
  get(scope: string, key: string): { statusCode: number; body: string } | null;
  put(scope: string, key: string, statusCode: number, body: string): void;
}
