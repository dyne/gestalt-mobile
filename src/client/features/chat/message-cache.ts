import type { ChatMessage } from './message-store.js';

const databaseName = 'codex-relay';
const storeName = 'messages';
const messageLimit = 200;

export function retainRecentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-messageLimit);
}

export type MessageCache = {
  read(sessionId: string): Promise<ChatMessage[]>;
  write(sessionId: string, messages: ChatMessage[]): Promise<void>;
};

export function createMessageCache(database: IDBFactory | undefined = globalThis.indexedDB): MessageCache {
  if (!database) return { read: async () => [], write: async () => {} };
  const open = new Promise<IDBDatabase>((resolve, reject) => {
    const request = database.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async read(sessionId) {
      try {
        const db = await open;
        return await transaction<ChatMessage[]>(db, 'readonly', (store) => store.get(sessionId));
      } catch {
        return [];
      }
    },
    async write(sessionId, messages) {
      try {
        const db = await open;
        await transaction(db, 'readwrite', (store) => store.put(retainRecentMessages(messages), sessionId));
      } catch {
        // Cache failure must never block the live relay experience.
      }
    },
  };
}

function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = operation(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
