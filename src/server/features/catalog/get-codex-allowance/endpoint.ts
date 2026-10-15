/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { CodexAllowance } from '../../../../shared/contracts/codex-allowance.js';
import { problem } from '../../../platform/http/problem.js';

export type CodexAllowanceReader = { read(): Promise<CodexAllowance> };

export function registerGetCodexAllowance(
  app: FastifyInstance,
  reader: CodexAllowanceReader,
): void {
  app.get('/api/codex/allowance', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await reader.read();
    } catch {
      return reply
        .code(503)
        .type('application/problem+json')
        .send(
          problem(
            'CODEX_ALLOWANCE_UNAVAILABLE',
            503,
            'Codex allowance is temporarily unavailable.',
          ),
        );
    }
  });
}
