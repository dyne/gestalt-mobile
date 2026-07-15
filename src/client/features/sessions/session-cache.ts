import { deleteStore, openClientDatabase, readStore, writeStore } from '../client-database.js';

const settingsStore = 'settings';
const draftsStore = 'drafts';
const cursorsStore = 'cursors';
const selectedSessionKey = 'selected-session';

export type SessionCache = {
  readSelectedSession(): Promise<string | null>;
  saveSelectedSession(sessionId: string | null): Promise<void>;
  readDraft(sessionId: string): Promise<string>;
  saveDraft(sessionId: string, value: string): Promise<void>;
  readCursor(sessionId: string): Promise<number>;
  saveCursor(sessionId: string, cursor: number): Promise<void>;
};

export function createSessionCache(
  database: IDBFactory | undefined = globalThis.indexedDB,
): SessionCache {
  if (!database) return noOpSessionCache;
  const open = openClientDatabase(database);
  return {
    async readSelectedSession() {
      try {
        return (await readStore<string>(await open, settingsStore, selectedSessionKey)) ?? null;
      } catch {
        return null;
      }
    },
    async saveSelectedSession(sessionId) {
      try {
        const db = await open;
        if (sessionId) await writeStore(db, settingsStore, selectedSessionKey, sessionId);
        else await deleteStore(db, settingsStore, selectedSessionKey);
      } catch {
        // Cache failures must not interrupt session control.
      }
    },
    async readDraft(sessionId) {
      try {
        return (await readStore<string>(await open, draftsStore, sessionId)) ?? '';
      } catch {
        return '';
      }
    },
    async saveDraft(sessionId, value) {
      try {
        await writeStore(await open, draftsStore, sessionId, value);
      } catch {
        // Cache failures must not interrupt composition.
      }
    },
    async readCursor(sessionId) {
      try {
        const cursor = await readStore<unknown>(await open, cursorsStore, sessionId);
        return typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0
          ? cursor
          : 0;
      } catch {
        return 0;
      }
    },
    async saveCursor(sessionId, cursor) {
      try {
        await writeStore(await open, cursorsStore, sessionId, cursor);
      } catch {
        // Cache failures must not interrupt event replay.
      }
    },
  };
}

const noOpSessionCache: SessionCache = {
  readSelectedSession: async () => null,
  saveSelectedSession: async () => {},
  readDraft: async () => '',
  saveDraft: async () => {},
  readCursor: async () => 0,
  saveCursor: async () => {},
};
