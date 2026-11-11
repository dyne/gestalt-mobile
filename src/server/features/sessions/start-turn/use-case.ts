/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { WorkspaceSessionConflict } from '../application/workspace-conflict.js';
import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';
import {
  WriterAcquisitionError,
  type WriterAcquisition,
  writerAcquisitionProblem,
} from '../application/writer-acquisition.js';

export type StartTurnDependencies = {
  find(id: string): RelaySessionSnapshot | null;
  start(
    session: RelaySessionSnapshot,
    text: string,
    clientUserMessageId?: string,
  ): Promise<RelaySessionSnapshot>;
  ensureWriter?(session: RelaySessionSnapshot): Promise<WriterAcquisition>;
  releaseWriter?(id: string): void | Promise<void>;
  save(session: RelaySessionSnapshot): void;
  onStarted?(session: RelaySessionSnapshot): void;
  onAccepted?(session: RelaySessionSnapshot, key?: string): void;
  onSettled?(sessionId: string): void;
  idempotency?: {
    get(scope: string, key: string): { statusCode: number; body: string } | null;
    put(scope: string, key: string, statusCode: number, body: string): void;
  };
};
export type StartTurnOutcome =
  | { kind: 'accepted'; session: RelaySessionSnapshot }
  | { kind: 'rejected'; statusCode: number; problem: unknown };
export type SubmitSessionTurn = ((input: {
  sessionId: string;
  text: string;
  key?: string;
}) => Promise<StartTurnOutcome>) & { pending?(sessionId: string): boolean };

/** Ordinary turn acceptance, shared by HTTP and application callers with one serialization boundary. */
export function createStartTurn(deps: StartTurnDependencies): SubmitSessionTurn {
  const inflight = new Map<string, Promise<{ statusCode: number; body: string }>>();
  const sessionOperations = new Map<string, Promise<void>>();
  const pending = new Map<string, number>();
  const submit: SubmitSessionTurn = async ({ sessionId, text: rawText, key }) => {
    const session = deps.find(sessionId);
    if (!session)
      return { kind: 'rejected', statusCode: 404, problem: { code: 'SESSION_NOT_FOUND' } };
    const text = rawText.trim();
    if (text.length > 100_000)
      return { kind: 'rejected', statusCode: 400, problem: { code: 'TURN_INPUT_TOO_LONG' } };
    if (!text) return { kind: 'rejected', statusCode: 409, problem: { code: 'SESSION_NOT_READY' } };
    if (key && deps.idempotency) {
      const scope = `start-turn:${session.id}`;
      const fingerprint = createHash('sha256').update(text).digest('hex');
      const cached = deps.idempotency.get(scope, key);
      if (cached) return replay(cached, fingerprint);
      const inflightKey = `${scope}:${key}`;
      const operation =
        inflight.get(inflightKey) ??
        serializeSession(sessionOperations, session.id, async () => {
          const current = deps.find(session.id);
          if (!current)
            return { statusCode: 404, body: JSON.stringify({ code: 'SESSION_NOT_FOUND' }) };
          const durable = deps.idempotency!.get(scope, key);
          if (durable) return durable;
          if (current.state === 'turnActive')
            return { statusCode: 409, body: JSON.stringify({ code: 'SESSION_TURN_ACTIVE' }) };
          let started: RelaySessionSnapshot;
          try {
            started = await startWithWriter(deps, current, text, key);
          } catch (error) {
            if (error instanceof StartTurnProblem) return error.result;
            throw error;
          }
          const result = {
            statusCode: 202,
            body: JSON.stringify({ fingerprint, response: started }),
          };
          return result;
        });
      inflight.set(inflightKey, operation);
      try {
        return replay(await operation, fingerprint);
      } finally {
        inflight.delete(inflightKey);
      }
    }
    return serializeSession(sessionOperations, session.id, async () => {
      const current = deps.find(session.id);
      if (!current)
        return {
          kind: 'rejected' as const,
          statusCode: 404,
          problem: { code: 'SESSION_NOT_FOUND' },
        };
      if (current.state === 'turnActive')
        return {
          kind: 'rejected' as const,
          statusCode: 409,
          problem: { code: 'SESSION_TURN_ACTIVE' },
        };
      try {
        return {
          kind: 'accepted' as const,
          session: await startWithWriter(deps, current, text, key),
        };
      } catch (error) {
        if (error instanceof StartTurnProblem)
          return {
            kind: 'rejected' as const,
            statusCode: error.result.statusCode,
            problem: JSON.parse(error.result.body),
          };
        throw error;
      }
    });
  };
  return Object.assign(
    async (input: Parameters<SubmitSessionTurn>[0]) => {
      pending.set(input.sessionId, (pending.get(input.sessionId) ?? 0) + 1);
      try {
        return await submit(input);
      } finally {
        const count = (pending.get(input.sessionId) ?? 1) - 1;
        if (count) pending.set(input.sessionId, count);
        else {
          pending.delete(input.sessionId);
          deps.onSettled?.(input.sessionId);
        }
      }
    },
    { pending: (id: string) => pending.has(id) },
  );
}

async function startWithWriter(
  deps: StartTurnDependencies,
  session: RelaySessionSnapshot,
  text: string,
  key: string | undefined,
): Promise<RelaySessionSnapshot> {
  const writable = await ensureWriter(deps, session);
  if ('body' in writable) throw new StartTurnProblem(writable);
  if (writable.persisted) {
    const current = deps.find(session.id);
    if (current?.desiredState !== 'active' || current.threadId !== writable.session.threadId)
      throw new StartTurnProblem({
        statusCode: 409,
        body: JSON.stringify({ code: 'SESSION_NOT_READY' }),
      });
  }
  try {
    if (writable.session !== session && !writable.persisted) deps.save(writable.session);
  } catch (error) {
    await cleanupAcquiredWriter(deps, writable.session, session);
    throw error;
  }
  let accepted = false;
  try {
    const started = await deps.start(writable.session, text, key);
    accepted = true;
    const current = deps.find(session.id);
    if (!current) return started;
    // Persist the normal acceptance receipt before a later snapshot/event write can fail.
    if (key)
      deps.idempotency?.put(
        `start-turn:${session.id}`,
        key,
        202,
        JSON.stringify({ fingerprint: fingerprintTurnInput(text), response: started }),
      );
    deps.onAccepted?.(started, key);
    if (current?.desiredState === 'stopped') deps.save(current);
    else {
      deps.save(started);
      deps.onStarted?.(started);
    }
    return started;
  } catch (error) {
    if (!accepted && writable.session !== session && !writable.persisted)
      await cleanupAcquiredWriter(deps, writable.session, session);
    throw error;
  }
}

export function fingerprintTurnInput(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

/** Reads a durable ordinary receipt without activating a writer or submitting a turn. */
export function readAcceptedTurn(
  store: NonNullable<StartTurnDependencies['idempotency']>,
  sessionId: string,
  key: string,
  fingerprint: string,
): RelaySessionSnapshot | null {
  const result = store.get(`start-turn:${sessionId}`, key);
  if (!result || result.statusCode !== 202) return null;
  try {
    const body = JSON.parse(result.body) as {
      fingerprint?: string;
      response?: RelaySessionSnapshot;
    };
    return body.fingerprint === fingerprint &&
      body.response?.id === sessionId &&
      typeof body.response.activeTurnId === 'string' &&
      body.response.activeTurnId
      ? body.response
      : null;
  } catch {
    return null;
  }
}

class StartTurnProblem extends Error {
  constructor(readonly result: { statusCode: number; body: string }) {
    super('START_TURN_PROBLEM');
  }
}

async function serializeSession<T>(
  operations: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = operations.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  operations.set(sessionId, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (operations.get(sessionId) === current) operations.delete(sessionId);
  }
}

/** Cleanup is best effort: never replace the original start/persistence error. */
async function cleanupAcquiredWriter(
  deps: StartTurnDependencies,
  acquired: RelaySessionSnapshot,
  original: RelaySessionSnapshot,
): Promise<void> {
  try {
    await deps.releaseWriter?.(acquired.id);
  } catch {
    // Keep the workspace reservation when shutdown could not be confirmed.
    return;
  }
  try {
    deps.save(original);
  } catch {
    // The original I/O failure remains the observable failure.
  }
}

async function ensureWriter(
  deps: StartTurnDependencies,
  session: RelaySessionSnapshot,
): Promise<WriterAcquisition | { statusCode: number; body: string }> {
  if (!deps.ensureWriter) {
    if (session.state === 'ready') return { session, replacementCreated: false };
    return failure('runtimeUnavailable');
  }
  try {
    return await deps.ensureWriter(session);
  } catch (error) {
    if (error instanceof WorkspaceSessionConflict)
      return {
        statusCode: 409,
        body: JSON.stringify({
          code: error.code,
          detail: error.message,
          sessionId: error.sessionId,
          retryable: true,
        }),
      };
    if (
      error instanceof WriterAcquisitionError &&
      error.kind === 'writerBusy' &&
      session.state !== 'stopped'
    )
      deps.save(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
    return failure(error instanceof WriterAcquisitionError ? error.kind : 'runtimeUnavailable');
  }
}

function failure(kind: Parameters<typeof writerAcquisitionProblem>[0]): {
  statusCode: number;
  body: string;
} {
  const problem = writerAcquisitionProblem(kind);
  return { statusCode: problem.status, body: JSON.stringify(problem) };
}

function replay(
  result: { statusCode: number; body: string },
  fingerprint: string,
): StartTurnOutcome {
  const cached = JSON.parse(result.body) as {
    fingerprint?: string;
    response?: RelaySessionSnapshot;
  };
  if (cached.fingerprint === undefined)
    return { kind: 'rejected', statusCode: result.statusCode, problem: cached };
  if (cached.fingerprint !== fingerprint)
    return { kind: 'rejected', statusCode: 409, problem: { code: 'IDEMPOTENCY_KEY_REUSED' } };
  return { kind: 'accepted', session: cached.response! };
}
