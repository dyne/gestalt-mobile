/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerStartTurn(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    start(session: RelaySessionSnapshot, text: string): Promise<RelaySessionSnapshot>;
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
    if (!text || session.state !== 'ready')
      return reply.code(409).send({ code: 'SESSION_NOT_READY' });
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
          const started = await deps.start(session, text);
          deps.save(started);
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
    const started = await deps.start(session, text);
    deps.save(started);
    deps.onStarted?.(started);
    return reply.code(202).send(started);
  });
}

function replay(
  result: { statusCode: number; body: string },
  fingerprint: string,
  reply: { code(status: number): { send(value: unknown): unknown } },
) {
  const cached = JSON.parse(result.body) as { fingerprint?: string; response?: unknown };
  if (cached.fingerprint !== fingerprint)
    return reply.code(409).send({ code: 'IDEMPOTENCY_KEY_REUSED' });
  return reply.code(result.statusCode).send(cached.response);
}
