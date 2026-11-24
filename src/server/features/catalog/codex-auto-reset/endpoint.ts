/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CodexAutoResetStatus } from '../../../../shared/contracts/codex-allowance.js';

export type CodexAutoResetPreferences = {
  status(): CodexAutoResetStatus;
  setEnabled(enabled: boolean): void;
};

export function registerCodexAutoReset(
  app: FastifyInstance,
  preferences: CodexAutoResetPreferences,
): void {
  app.get('/api/codex/allowance/auto-reset', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return preferences.status();
  });
  app.put('/api/codex/allowance/auto-reset', async (request, reply) => {
    const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_CODEX_AUTO_RESET' });
    preferences.setEnabled(parsed.data.enabled);
    return preferences.status();
  });
}
