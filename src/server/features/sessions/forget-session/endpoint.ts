/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerForgetSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    close(id: string): void | Promise<void>;
    remove(id: string): void;
  },
): void {
  app.delete('/api/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.find(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    await deps.close(id);
    deps.remove(id);
    return reply.code(204).send();
  });
}
