/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { createStartTurn, type StartTurnDependencies, type SubmitSessionTurn } from './use-case.js';

export function registerStartTurn(
  app: FastifyInstance,
  deps: StartTurnDependencies & { submit?: SubmitSessionTurn },
): void {
  const submit = deps.submit ?? createStartTurn(deps);
  app.post('/api/sessions/:id/turns', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    const result = await submit({
      sessionId: (request.params as { id: string }).id,
      text: (request.body as { text?: string }).text ?? '',
      ...(typeof key === 'string' ? { key } : {}),
    });
    return result.kind === 'accepted'
      ? reply.code(202).send(result.session)
      : reply.code(result.statusCode).send(result.problem);
  });
}
