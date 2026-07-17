/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const requestSchema = z.object({
  address: z.string().trim().min(1).max(2_048),
  workspaceId: z.string().trim().min(1),
});

export function registerCloneRepository(
  app: FastifyInstance,
  deps: { clone(workspaceId: string, address: string): Promise<void> },
): void {
  app.post('/api/git/clone', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_CLONE_ADDRESS' });
    await deps.clone(parsed.data.workspaceId, parsed.data.address);
    return reply.code(202).send({ accepted: true });
  });
}
