/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type {
  OrgPlanPreparation,
  OrgPlanReference,
} from '../../../../shared/contracts/org-plan-execution.js';

export function registerPrepareOrgPlanSupervision(
  app: FastifyInstance,
  deps: {
    prepare(
      reference: OrgPlanReference,
      expectedRevision?: string,
      skillProfile?: string,
    ): Promise<OrgPlanPreparation>;
  },
): void {
  app.post('/api/plans/prepare', async (request, reply) => {
    const reference = parseReference(request.body);
    if (!reference) return reply.code(400).send({ code: 'PLAN_REFERENCE_REQUIRED' });
    const expectedRevision = (request.body as { expectedRevision?: string }).expectedRevision;
    const skillProfile = (request.body as { skillProfile?: string }).skillProfile;
    const result =
      skillProfile !== undefined
        ? await deps.prepare(reference, expectedRevision, skillProfile)
        : expectedRevision
          ? await deps.prepare(reference, expectedRevision)
          : await deps.prepare(reference);
    return reply
      .code(result.kind === 'blocked' && result.code === 'CONTEXT_CHANGED' ? 409 : 200)
      .send(result);
  });
}

function parseReference(value: unknown): OrgPlanReference | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (
    input.skillProfile !== undefined &&
    (typeof input.skillProfile !== 'string' || input.skillProfile.length > 256)
  )
    return null;
  if (
    input.expectedRevision !== undefined &&
    (typeof input.expectedRevision !== 'string' || !input.expectedRevision)
  )
    return null;
  if (input.kind === 'retained-session') {
    if (
      Object.keys(input).some(
        (key) => !['kind', 'sessionId', 'expectedRevision', 'skillProfile'].includes(key),
      ) ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId
    )
      return null;
    return { kind: 'retained-session', sessionId: input.sessionId };
  }
  const idKey =
    input.kind === 'workspace' ? 'workspaceId' : input.kind === 'session' ? 'sessionId' : null;
  if (
    !idKey ||
    Object.keys(input).some(
      (key) => !['kind', idKey, 'planName', 'expectedRevision', 'skillProfile'].includes(key),
    )
  )
    return null;
  if (
    typeof input[idKey] !== 'string' ||
    !input[idKey] ||
    typeof input.planName !== 'string' ||
    !input.planName
  )
    return null;
  return input.kind === 'workspace'
    ? { kind: 'workspace', workspaceId: input[idKey], planName: input.planName }
    : { kind: 'session', sessionId: input[idKey], planName: input.planName };
}
