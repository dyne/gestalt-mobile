/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { RelaySession } from '../model/relay-session.js';
import {
  WriterAcquisitionError,
  type WriterAcquisition,
  writerAcquisitionProblem,
} from '../application/writer-acquisition.js';

export function registerStartTurn(
  app: FastifyInstance,
  deps: {
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
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  const inflight = new Map<string, Promise<{ statusCode: number; body: string }>>();
  // Durable idempotency results are session-scoped and replay for as long as the
  // store retains them; a reused key with a different prompt is rejected.
  // Text is capped at 100,000 characters; leave room for JSON encoding only.
  app.post('/api/sessions/:id/turns', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const text = (request.body as { text?: string }).text?.trim() ?? '';
    if (text.length > 100_000) return reply.code(400).send({ code: 'TURN_INPUT_TOO_LONG' });
    if (!text) return reply.code(409).send({ code: 'SESSION_NOT_READY' });
    if (session.state === 'turnActive')
      return reply.code(409).send({ code: 'SESSION_TURN_ACTIVE' });
    const key = request.headers['idempotency-key'];
    if (typeof key === 'string' && key && deps.idempotency) {
      const scope = `start-turn:${session.id}`;
      const fingerprint = createHash('sha256').update(text).digest('hex');
      const cached = deps.idempotency.get(scope, key);
      if (cached) return replay(cached, fingerprint, reply);
      const inflightKey = `${scope}:${key}`;
      const operation =
        inflight.get(inflightKey) ??
        (async () => {
          const writable = await ensureWriter(deps, session);
          if ('body' in writable) return writable;
          // Persist the acquired writer before turn/start so a crash cannot claim
          // a detached row owns a turn.  Failure to persist releases the child.
          try {
            if (writable.session !== session) deps.save(writable.session);
          } catch (error) {
            await cleanupAcquiredWriter(deps, writable.session, session);
            throw error;
          }
          let started: RelaySessionSnapshot;
          try {
            started = await deps.start(writable.session, text, key);
            deps.save(started);
          } catch (error) {
            if (writable.session !== session) {
              await cleanupAcquiredWriter(deps, writable.session, session);
            }
            throw error;
          }
          deps.onStarted?.(started);
          const result = {
            statusCode: 202,
            body: JSON.stringify({ fingerprint, response: started }),
          };
          deps.idempotency!.put(scope, key, result.statusCode, result.body);
          return result;
        })();
      inflight.set(inflightKey, operation);
      try {
        return replay(await operation, fingerprint, reply);
      } finally {
        inflight.delete(inflightKey);
      }
    }
    const writable = await ensureWriter(deps, session);
    if ('body' in writable) return reply.code(writable.statusCode).send(JSON.parse(writable.body));
    try {
      if (writable.session !== session) deps.save(writable.session);
    } catch (error) {
      await cleanupAcquiredWriter(deps, writable.session, session);
      throw error;
    }
    let started: RelaySessionSnapshot;
    try {
      started = await deps.start(
        writable.session,
        text,
        typeof key === 'string' && key ? key : undefined,
      );
      deps.save(started);
    } catch (error) {
      if (writable.session !== session) {
        await cleanupAcquiredWriter(deps, writable.session, session);
      }
      throw error;
    }
    deps.onStarted?.(started);
    return reply.code(202).send(started);
  });
}

/** Cleanup is best effort: never replace the original start/persistence error. */
async function cleanupAcquiredWriter(
  deps: Parameters<typeof registerStartTurn>[1],
  acquired: RelaySessionSnapshot,
  original: RelaySessionSnapshot,
): Promise<void> {
  try {
    await deps.releaseWriter?.(acquired.id);
  } catch {
    // Process loss is already a valid release outcome.
  }
  try {
    deps.save(original);
  } catch {
    // The original I/O failure remains the observable failure.
  }
}

async function ensureWriter(
  deps: Parameters<typeof registerStartTurn>[1],
  session: RelaySessionSnapshot,
): Promise<WriterAcquisition | { statusCode: number; body: string }> {
  if (!deps.ensureWriter) {
    if (session.state === 'ready') return { session, replacementCreated: false };
    return failure('runtimeUnavailable');
  }
  try {
    return await deps.ensureWriter(session);
  } catch (error) {
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
  reply: { code(status: number): { send(value: unknown): unknown } },
) {
  const cached = JSON.parse(result.body) as { fingerprint?: string; response?: unknown };
  if (cached.fingerprint === undefined) return reply.code(result.statusCode).send(cached);
  if (cached.fingerprint !== fingerprint)
    return reply.code(409).send({ code: 'IDEMPOTENCY_KEY_REUSED' });
  return reply.code(result.statusCode).send(cached.response);
}
