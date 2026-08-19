/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import {
  parseOrgPlanAttentionResponse,
  toOrgPlanAttentionToolResponse,
} from '../../../../shared/contracts/org-plan-attention.js';
import type { OrgPlanAttentionResolver } from '../application/ports.js';

export function registerResolveOrgPlanAttention(
  app: FastifyInstance,
  deps: { resolver: OrgPlanAttentionResolver },
): void {
  app.post('/api/sessions/:id/attention/:requestId/resolve', async (request, reply) => {
    const { id: sessionId, requestId } = request.params as { id: string; requestId: string };
    const body = request.body as Record<string, unknown>;
    const validFields =
      body &&
      Object.keys(body).every((key) => ['operationKey', 'action', 'guidance'].includes(key));
    const response = validFields
      ? parseOrgPlanAttentionResponse({
          action: body.action,
          ...(body.guidance === undefined ? {} : { guidance: body.guidance }),
        })
      : null;
    const operationKey =
      typeof body?.operationKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.operationKey)
        ? body.operationKey
        : null;
    if (!response || !operationKey)
      return reply.code(400).send({ code: 'ATTENTION_RESPONSE_INVALID' });
    const outcome = await deps.resolver.resolve({
      sessionId,
      requestId,
      operationKey,
      response: toOrgPlanAttentionToolResponse(response),
    });
    if (outcome.kind === 'accepted' || outcome.kind === 'replayed')
      return reply.code(202).send({
        accepted: true,
        replayed: outcome.kind === 'replayed',
        resolvedAt: outcome.resolvedAt,
      });
    const code =
      outcome.kind === 'noActive'
        ? 'ORG_PLAN_ATTENTION_NOT_ACTIVE'
        : outcome.kind === 'staleOperation'
          ? 'ATTENTION_OPERATION_STALE'
          : outcome.kind === 'legacyUnsupported'
            ? 'ATTENTION_LEGACY_UNSUPPORTED'
            : outcome.kind === 'writerCleared'
              ? 'ATTENTION_WRITER_CLEARED'
              : 'ATTENTION_WRITER_UNAVAILABLE';
    return reply.code(outcome.kind === 'noActive' ? 404 : 409).send({ code });
  });
}
