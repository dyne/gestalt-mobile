/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { PreviewService } from '../application/service.js';
import { problem } from '../../../platform/http/problem.js';

export function registerStopPreview(
  app: FastifyInstance,
  service: Pick<PreviewService, 'stop'>,
): void {
  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/preview',
    async (request, reply) => {
      if (!service.stop(request.params.sessionId))
        return reply
          .code(409)
          .type('application/problem+json')
          .send(problem('PREVIEW_BUSY', 409, 'Stop the preview in the other session first.'));
      return reply.code(204).send();
    },
  );
}
