/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerStartTurn(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    start(session: RelaySessionSnapshot, text: string): Promise<RelaySessionSnapshot>;
    save(session: RelaySessionSnapshot): void;
    onStarted?(session: RelaySessionSnapshot): void;
  },
): void {
  // Text is capped at 100,000 characters; leave room for JSON encoding only.
  app.post('/api/sessions/:id/turns', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const text = (request.body as { text?: string }).text?.trim() ?? '';
    if (text.length > 100_000) return reply.code(400).send({ code: 'TURN_INPUT_TOO_LONG' });
    if (!text || session.state !== 'ready')
      return reply.code(409).send({ code: 'SESSION_NOT_READY' });
    const started = await deps.start(session, text);
    deps.save(started);
    deps.onStarted?.(started);
    return reply.code(202).send(started);
  });
}
