/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
  readDraftEnvelope(sessionId: string): Promise<SessionDraft>;
  saveDraftEnvelope(sessionId: string, draft: SessionDraft): Promise<void>;
  replaceDraftText(sessionId: string, text: string, revision: number): Promise<void>;
  addPendingDraftOperation(sessionId: string, operation: PendingDraftOperation): Promise<void>;
  consumeAcceptedDraft(
    sessionId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<SessionDraft | null>;
  readCursor(sessionId: string): Promise<number>;
  saveCursor(sessionId: string, cursor: number): Promise<void>;
};

/** The revision belongs to local composition, never to a relay turn. */
export type PendingDraftOperation = Readonly<{
  operationId: string;
  text: string;
  revision: number;
  kind: 'send' | 'queue' | 'interrupt-send';
}>;
export type SessionDraft = Readonly<{
  text: string;
  revision: number;
  pending?: readonly PendingDraftOperation[];
}>;
const emptyDraft: SessionDraft = { text: '', revision: 0 };
const isDraft = (value: unknown): value is SessionDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as SessionDraft;
  const pending = draft.pending;
  return (
    typeof draft.text === 'string' &&
    Number.isSafeInteger(draft.revision) &&
    draft.revision >= 0 &&
    (pending === undefined ||
      (Array.isArray(pending) &&
        pending.every(
          (operation) =>
            Boolean(operation) &&
            typeof operation.operationId === 'string' &&
            typeof operation.text === 'string' &&
            Number.isSafeInteger(operation.revision) &&
            operation.revision >= 0 &&
            (operation.kind === 'send' ||
              operation.kind === 'queue' ||
              operation.kind === 'interrupt-send'),
        )))
  );
};

export function createSessionCache(
  database: IDBFactory | undefined = globalThis.indexedDB,
): SessionCache {
  if (!database) return noOpSessionCache;
  const open = openClientDatabase(database);
  const draftWrites = new Map<string, Promise<void>>();
  const latestDrafts = new Map<string, SessionDraft>();
  const saveDraftEnvelope = async (sessionId: string, draft: SessionDraft): Promise<void> => {
    const current = latestDrafts.get(sessionId);
    if (current && current.revision > draft.revision) return;
    latestDrafts.set(sessionId, draft);
    const previous = draftWrites.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        // A later local revision supersedes this queued write before it reaches IndexedDB.
        if (latestDrafts.get(sessionId) !== draft) return;
        try {
          await writeStore(await open, draftsStore, sessionId, draft);
        } catch {
          // Cache failures must not interrupt composition.
        }
      });
    draftWrites.set(sessionId, write);
    await write;
  };
  const replaceDraftText = async (
    sessionId: string,
    text: string,
    revision: number,
  ): Promise<void> => {
    const current = latestDrafts.get(sessionId);
    await saveDraftEnvelope(sessionId, {
      text,
      revision,
      pending: current?.pending,
    });
  };
  const addPendingDraftOperation = async (
    sessionId: string,
    operation: PendingDraftOperation,
  ): Promise<void> => {
    const current = latestDrafts.get(sessionId) ?? emptyDraft;
    await saveDraftEnvelope(sessionId, {
      ...current,
      pending: [
        ...(current.pending ?? []).filter((entry) => entry.operationId !== operation.operationId),
        operation,
      ].slice(-8),
    });
  };
  const consumeAcceptedDraft = async (
    sessionId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<SessionDraft | null> => {
    const previous = draftWrites.get(sessionId) ?? Promise.resolve();
    let consumed: SessionDraft | null = null;
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        let current = latestDrafts.get(sessionId);
        if (!current) {
          try {
            const stored = await readStore<unknown>(await open, draftsStore, sessionId);
            current = isDraft(stored)
              ? stored
              : typeof stored === 'string'
                ? { text: stored, revision: 0 }
                : emptyDraft;
          } catch {
            current = emptyDraft;
          }
        }
        if (
          current.revision !== expectedRevision ||
          !current.pending?.some((operation) => operation.operationId === operationId)
        )
          return;
        consumed = {
          text: '',
          revision: current.revision + 1,
          pending: current.pending.filter((operation) => operation.operationId !== operationId),
        };
        latestDrafts.set(sessionId, consumed);
        try {
          await writeStore(await open, draftsStore, sessionId, consumed);
        } catch {
          // Do not claim acceptance locally when its tombstone was not durable.
          // A newer edit may have been queued while the tombstone write was pending.
          // Never roll that edit back to the submitted revision on a storage failure.
          if (latestDrafts.get(sessionId) === consumed) latestDrafts.set(sessionId, current);
          consumed = null;
        }
      });
    draftWrites.set(sessionId, write);
    await write;
    return consumed;
  };
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
      return (await this.readDraftEnvelope(sessionId)).text;
    },
    async saveDraft(sessionId, value) {
      const current = await this.readDraftEnvelope(sessionId);
      await saveDraftEnvelope(sessionId, { text: value, revision: current.revision + 1 });
    },
    async readDraftEnvelope(sessionId) {
      try {
        const stored = await readStore<unknown>(await open, draftsStore, sessionId);
        // Old installations stored a string; it remains a usable revision-zero draft.
        const draft = isDraft(stored)
          ? stored
          : typeof stored === 'string'
            ? { text: stored, revision: 0 }
            : emptyDraft;
        const current = latestDrafts.get(sessionId);
        if (current && current.revision >= draft.revision) return current;
        latestDrafts.set(sessionId, draft);
        return draft;
      } catch {
        return latestDrafts.get(sessionId) ?? emptyDraft;
      }
    },
    saveDraftEnvelope,
    replaceDraftText,
    addPendingDraftOperation,
    consumeAcceptedDraft,
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
  readDraftEnvelope: async () => emptyDraft,
  saveDraftEnvelope: async () => {},
  replaceDraftText: async () => {},
  addPendingDraftOperation: async () => {},
  consumeAcceptedDraft: async () => null,
  readCursor: async () => 0,
  saveCursor: async () => {},
};
