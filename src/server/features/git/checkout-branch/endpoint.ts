/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

const requestSchema = z.object({ branch: z.string().min(1) });

export function registerCheckoutBranch(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    checkout(path: string, branch: string): Promise<void>;
  },
): void {
  app.post('/api/sessions/:id/git/checkout', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BRANCH' });
    try {
      await deps.checkout(session.workspacePath, parsed.data.branch);
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      return reply.code(409).send({
        code: 'GIT_CHECKOUT_FAILED',
        detail: error instanceof Error ? error.message : 'Git checkout failed.',
      });
    }
  });
}
