/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { OrgPlanAttentionReader } from '../application/ports.js';

/** Feature entry point for consumers that need only the active typed alert. */
export function registerGetActiveOrgPlanAttention(
  app: FastifyInstance,
  deps: { exists(sessionId: string): boolean; reader: OrgPlanAttentionReader },
): void {
  app.get('/api/sessions/:id/attention', async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    if (!deps.exists(sessionId)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const attention = deps.reader.active(sessionId);
    if (!attention)
      return reply.code(404).type('application/problem+json').send({
        type: 'urn:gestalt-mobile:error:org-plan-attention-not-active',
        title: 'No active Org Plan attention request',
        status: 404,
        code: 'ORG_PLAN_ATTENTION_NOT_ACTIVE',
      });
    return reply.send(attention);
  });
}
