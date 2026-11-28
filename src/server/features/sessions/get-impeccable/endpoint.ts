/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

export function registerGetImpeccable(
  app: FastifyInstance,
  available: (sessionId: string) => Promise<boolean>,
): void {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/impeccable', async (request) => ({
    available: await available(request.params.id),
  }));
}
