const selectedSessionKey = 'codex-relay:selected-session';
const cursorKey = (sessionId: string) => `codex-relay:cursor:${sessionId}`;

export function readSelectedSession(storage: Storage): string | null {
  return storage.getItem(selectedSessionKey);
}

export function saveSelectedSession(storage: Storage, sessionId: string | null): void {
  if (sessionId) storage.setItem(selectedSessionKey, sessionId);
  else storage.removeItem(selectedSessionKey);
}

export function readCursor(storage: Storage, sessionId: string): number {
  const value = Number(storage.getItem(cursorKey(sessionId)) ?? '0');
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function saveCursor(storage: Storage, sessionId: string, cursor: number): void {
  storage.setItem(cursorKey(sessionId), String(cursor));
}
