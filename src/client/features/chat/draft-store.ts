export const draftKey = (sessionId: string) => `codex-relay:draft:${sessionId}`;
export function saveDraft(storage: Storage, sessionId: string, value: string): void {
  storage.setItem(draftKey(sessionId), value);
}
export function readDraft(storage: Storage, sessionId: string): string {
  return storage.getItem(draftKey(sessionId)) ?? '';
}
