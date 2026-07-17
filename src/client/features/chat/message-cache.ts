/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ChatMessage } from './message-store.js';
import { openClientDatabase, readStore, writeStore } from '../client-database.js';

const storeName = 'messages';
const messageLimit = 200;

export function retainRecentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-messageLimit);
}

export type MessageCache = {
  read(sessionId: string): Promise<ChatMessage[]>;
  write(sessionId: string, messages: ChatMessage[]): Promise<void>;
};

export function createMessageCache(
  database: IDBFactory | undefined = globalThis.indexedDB,
): MessageCache {
  if (!database) return { read: async () => [], write: async () => {} };
  const open = openClientDatabase(database);
  return {
    async read(sessionId) {
      try {
        const db = await open;
        return (await readStore<ChatMessage[]>(db, storeName, sessionId)) ?? [];
      } catch {
        return [];
      }
    },
    async write(sessionId, messages) {
      try {
        const db = await open;
        await writeStore(db, storeName, sessionId, retainRecentMessages(messages));
      } catch {
        // Cache failure must never block the live relay experience.
      }
    },
  };
}
