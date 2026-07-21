/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GitWorkspaceResolver } from '../application/ports.js';
import { resolveCloneDestination } from '../application/clone-destination.js';

const requestSchema = z.object({
  address: z.string().trim().min(1).max(2_048),
  workspaceId: z.string().trim().min(1),
});

export function registerCloneRepository(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    clone(path: string, address: string): Promise<void>;
  },
): void {
  app.post('/api/git/clone', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_CLONE_ADDRESS' });
    const destination = await resolveCloneDestination(deps.workspaces, parsed.data.workspaceId);
    if (!destination.ok) return reply.code(destination.statusCode).send({ code: destination.code });
    await deps.clone(destination.path, parsed.data.address);
    return reply.code(202).send({ accepted: true });
  });
}
