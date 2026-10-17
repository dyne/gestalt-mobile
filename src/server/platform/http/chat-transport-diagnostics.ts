/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { TransportDiagnostic } from '../../../shared/contracts/chat-transport-diagnostics.js';

export function registerChatTransportDiagnostics(
  app: FastifyInstance,
  record: (id: string, event: TransportDiagnostic) => void,
): void {
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url !== '/api/sessions/:id/history' || request.method !== 'GET')
      return;
    // Do not record unauthorized requests or retain arbitrary paths, headers, bodies, or errors.
    if (reply.statusCode === 401 || reply.statusCode === 403 || reply.statusCode === 404) return;
    const observation: Partial<TransportDiagnostic> = {};
    for (const key of ['attempts', 'coalesced'] as const) {
      const raw = request.headers[`x-gestalt-history-${key}`];
      if (typeof raw === 'string' && /^[0-9]{1,15}$/.test(raw)) observation[key] = Number(raw);
    }
    try {
      record((request.params as { id: string }).id, {
        kind: 'history',
        durationMs: reply.elapsedTime,
        status: reply.statusCode,
        ...observation,
      });
    } catch {
      /* Diagnostic sinks cannot change request outcomes. */
    }
  });
}
