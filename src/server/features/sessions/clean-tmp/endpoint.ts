/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CleanTmpResult } from '../../../../shared/contracts/tmp-cleanup.js';
import type { ScratchCleanupResult } from './use-case.js';
import { problem } from '../../../platform/http/problem.js';

export interface TmpCleanupPort {
  execute(): Promise<ScratchCleanupResult>;
}

const requestSchema = z.object({}).strict();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const responseSchema = z.object({
  status: z.enum(['complete', 'partial']),
  folders: z.object({ removed: counter, skipped: counter, failed: counter }),
  workspaces: z.object({
    cleaned: counter,
    removed: counter,
    skipped: counter,
    failed: counter,
    unavailable: counter,
  }),
  reasons: z.object({
    protected: counter,
    busy: counter,
    lease: counter,
    unrecognized: counter,
    unsafe: counter,
    unavailable: counter,
    io: counter,
  }),
});

export function registerCleanTmp(app: FastifyInstance, cleanup?: TmpCleanupPort): void {
  app.post('/api/maintenance/clean-tmp', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (
      !requestSchema.safeParse(request.body === undefined ? {} : request.body).success ||
      !requestSchema.safeParse(request.query ?? {}).success
    )
      return reply
        .code(400)
        .send(problem('INVALID_REQUEST', 400, 'Clean TMP does not accept paths or options.'));
    if (!cleanup)
      return reply
        .code(503)
        .send(problem('TMP_CLEANUP_UNAVAILABLE', 503, 'Temporary cleanup is unavailable.'));
    try {
      const result = await cleanup.execute();
      const response: CleanTmpResult = responseSchema.parse({
        status: result.status,
        folders: {
          removed: result.folders.removed,
          skipped: result.folders.skipped,
          failed: result.folders.failed,
        },
        workspaces: {
          cleaned: result.workspaces.cleaned,
          removed: result.workspaces.removed,
          skipped: result.workspaces.skipped,
          failed: result.workspaces.failed,
          unavailable: result.workspaces.unavailable,
        },
        reasons: result.folders.reasons,
      });
      return reply.send(response);
    } catch {
      return reply
        .code(503)
        .send(problem('TMP_CLEANUP_UNAVAILABLE', 503, 'Could not inspect temporary storage.'));
    }
  });
}
