/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { previewHandoffPath, type OpenPreview } from '../../../../shared/contracts/preview.js';
import { problem } from '../../../platform/http/problem.js';
import { parseAuthorizationSessionId } from '../../auth/domain/identifiers.js';
import type { PreviewService } from '../application/service.js';

export function registerOpenPreview(
  app: FastifyInstance,
  deps: { service: Pick<PreviewService, 'open'>; origin: string },
): void {
  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/preview',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const login = parseAuthorizationSessionId(request.cookies.gestalt_mobile_session);
      const result = login
        ? deps.service.open(request.params.sessionId, login)
        : ({ kind: 'unauthorized' } as const);
      if (result.kind === 'opened') {
        const url = new URL(previewHandoffPath, deps.origin);
        url.hash = result.code;
        return { url: url.href } satisfies OpenPreview;
      }
      const errors = {
        inactive: [404, 'PREVIEW_SESSION_INACTIVE', 'Open an active chat session first.'],
        unauthorized: [401, 'AUTH_REQUIRED', 'Authentication is required.'],
        busy: [409, 'PREVIEW_BUSY', 'Stop the preview in the other session first.'],
        limit: [429, 'PREVIEW_LIMIT', 'Too many preview authorizations. Try again later.'],
      } as const;
      const [status, code, title] = errors[result.kind];
      return reply
        .code(status)
        .type('application/problem+json')
        .send(problem(code, status, title));
    },
  );
}
