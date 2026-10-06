/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DebugContext, SelfDebugSession } from '../../../shared/contracts/self-debug.js';
import type { RelaySessionSnapshot } from '../sessions/model/relay-session.js';
import { problem } from '../../platform/http/problem.js';

export type SelfDebugDependencies = {
  find(id: string): RelaySessionSnapshot | null;
  context(session: RelaySessionSnapshot): DebugContext;
  createId(): string;
  now(): string;
  create(context: DebugContext): Promise<RelaySessionSnapshot>;
  readTrace(debug: SelfDebugSession): Promise<string>;
};

const paramsSchema = z.object({ sessionId: z.string().min(1).max(200) });
const bodySchema = z.object({ confirmationId: z.string().min(1).max(200) }).strict();

/** A confirmation is bound to one existing thread; repeat submits share the same operation. */
export function registerSelfDebug(app: FastifyInstance, deps: SelfDebugDependencies): void {
  const confirmations = new Map<
    string,
    {
      context: DebugContext;
      expiresAt: number;
      operation?: Promise<RelaySessionSnapshot>;
    }
  >();

  app.get('/api/sessions/:sessionId/debug', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    const source = parsed.success ? deps.find(parsed.data.sessionId) : null;
    if (!source?.threadId)
      return reply
        .code(404)
        .send(problem('DEBUG_SESSION_NOT_FOUND', 404, 'Select an existing Chat session.'));
    const now = Date.parse(deps.now());
    for (const [key, value] of confirmations) if (value.expiresAt <= now) confirmations.delete(key);
    if (confirmations.size >= 100)
      return reply
        .code(429)
        .send(
          problem(
            'DEBUG_CONFIRMATION_LIMIT',
            429,
            'Too many pending debug requests. Try again shortly.',
          ),
        );
    const confirmationId = deps.createId();
    const context = deps.context(source);
    confirmations.set(confirmationId, { context, expiresAt: now + 30 * 60 * 1000 });
    return { confirmationId, context };
  });

  app.post('/api/sessions/:sessionId/debug', { bodyLimit: 1024 }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    const confirmation = body.success ? confirmations.get(body.data.confirmationId) : null;
    if (
      !params.success ||
      !confirmation ||
      confirmation.context.mobileSession !== params.data.sessionId ||
      confirmation.expiresAt <= Date.parse(deps.now())
    )
      return reply
        .code(409)
        .send(
          problem(
            'DEBUG_CONFIRMATION_EXPIRED',
            409,
            'Reopen DEBUG to confirm the current session details.',
          ),
        );
    if (!confirmation.operation) {
      const source = deps.find(params.data.sessionId);
      if (
        !source ||
        source.threadId !== (confirmation.context.sourceThread ?? confirmation.context.codexThread)
      )
        return reply
          .code(409)
          .send(problem('DEBUG_SOURCE_CHANGED', 409, 'The source session changed. Reopen DEBUG.'));
      confirmation.operation = deps.create(confirmation.context);
    }
    try {
      return reply.code(202).send(await confirmation.operation);
    } catch {
      // Keep the rejected operation: a transport retry must never duplicate a partial session.
      return reply
        .code(503)
        .send(
          problem(
            'DEBUG_START_FAILED',
            503,
            'Self DEBUG could not start. Check Sessions for a saved debug session before trying again.',
          ),
        );
    }
  });

  app.get('/api/sessions/:sessionId/debug/trace', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const session = params.success ? deps.find(params.data.sessionId) : null;
    if (!session?.selfDebug)
      return reply
        .code(404)
        .send(problem('DEBUG_TRACE_NOT_FOUND', 404, 'This session has no diagnostic trace.'));
    try {
      return reply
        .type('application/json; charset=utf-8')
        .send(await deps.readTrace(session.selfDebug));
    } catch {
      return reply
        .code(404)
        .send(
          problem('DEBUG_TRACE_NOT_FOUND', 404, 'The diagnostic trace is no longer available.'),
        );
    }
  });
}
