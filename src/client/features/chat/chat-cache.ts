/*
 * Copyright (C) 2026 Dyne.org foundation
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { openClientDatabase, readStore, writeStore } from '../client-database.js';
import type { ChatProjection } from './chat-projection.js';
import type { ChatCache } from './chat-controller.js';

const store = 'chat-projections';
export const serializeChatCache = (projection: ChatProjection) => ({
  version: 1,
  cursor: projection.cursor,
  lifecycle: projection.lifecycle,
  activeTurnId: projection.activeTurnId,
  messages: projection.messages.filter((message) => message.role === 'user').slice(-200),
  activities: [],
  prompts: projection.prompts.slice(-200),
  interactions: projection.interactions
    .map(({ requestId, key, kind, turnId, state, operationId, attemptedOutcome }) => ({
      requestId,
      key,
      kind,
      ...(turnId ? { turnId } : {}),
      state,
      ...(operationId ? { operationId } : {}),
      ...(state === 'resolved' &&
      (attemptedOutcome === 'approved' ||
        attemptedOutcome === 'denied' ||
        attemptedOutcome === 'answered')
        ? { attemptedOutcome }
        : {}),
      ...(typeof attemptedOutcome === 'object' &&
      attemptedOutcome !== null &&
      ((attemptedOutcome as { decision?: unknown }).decision === 'accept' ||
        (attemptedOutcome as { decision?: unknown }).decision === 'decline')
        ? {
            attemptedOutcome: {
              decision: (attemptedOutcome as { decision: 'accept' | 'decline' }).decision,
            },
          }
        : {}),
    }))
    .slice(-200),
  buffered: [],
});
/** Best-effort only: IndexedDB is never part of live-chat correctness. */
export function createChatCache(
  database: IDBFactory | undefined = globalThis.indexedDB,
): ChatCache {
  if (!database) return { read: async () => null, write: async () => {} };
  const open = openClientDatabase(database);
  return {
    read: async (sessionId) => {
      try {
        return await readStore<unknown>(await open, store, sessionId);
      } catch {
        return null;
      }
    },
    write: async (sessionId, projection) => {
      try {
        await writeStore(await open, store, sessionId, serializeChatCache(projection));
      } catch {
        /* cache failure is intentionally silent */
      }
    },
  };
}
