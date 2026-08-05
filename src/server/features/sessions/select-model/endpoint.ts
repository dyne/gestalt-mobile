/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';

export function registerSelectModel(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    models(): Promise<string[]>;
    now(): string;
    save(session: RelaySessionSnapshot): void;
  },
): void {
  app.post('/api/sessions/:id/model', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const model = (request.body as { model?: string }).model;
    if (typeof model !== 'string') return reply.code(400).send({ code: 'MODEL_REQUIRED' });
    if (!(await deps.models()).includes(model))
      return reply.code(400).send({ code: 'MODEL_UNAVAILABLE' });
    if (session.state !== 'ready') return reply.code(409).send({ code: 'SESSION_NOT_READY' });
    const selected = RelaySession.rehydrate(session).selectModel(model, deps.now()).snapshot;
    deps.save(selected);
    return reply.send(selected);
  });
}
