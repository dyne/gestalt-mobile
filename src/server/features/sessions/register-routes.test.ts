/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerProblemHandler } from '../../platform/http/problem-handler.js';
import {
  WriterAcquisitionError,
  writerAcquisitionProblem,
  type WriterAcquisitionFailureKind,
} from './application/writer-acquisition.js';
import { registerSessionRoutes } from './register-routes.js';

describe('session-start failure logging', () => {
  const kinds = [
    'workspaceLocked',
    'writerBusy',
    'supervisorReplaced',
    'rolloutMissing',
    'workspaceUnavailable',
    'runtimeDependencyFailed',
    'protocolIncompatible',
    'runtimeUnavailable',
  ] as const satisfies readonly WriterAcquisitionFailureKind[];

  it.each(kinds)('retains the safe %s reason in the CLI log and HTTP response', async (kind) => {
    const app = fastify();
    registerProblemHandler(app);
    const errorLog = vi.fn();
    registerSessionRoutes(app, {
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
      sessionRoutes: {
        createId: () => 'new-session',
        now: () => '2026-11-12T21:30:00.000Z',
        save: vi.fn(),
        find: () => null,
        workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        skillProfiles: {
          readGlobalProfile: async () => undefined,
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
        publish: async () => {
          const error = new WriterAcquisitionError(kind);
          error.message = 'private runtime detail';
          throw error;
        },
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
      });
      const expected = writerAcquisitionProblem(kind);
      expect(response.statusCode).toBe(expected.status);
      expect(response.json()).toMatchObject({ code: expected.code });
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(`start-session failed: ${expected.code}`);
      expect(response.body).not.toContain('private runtime detail');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private runtime detail');
    } finally {
      await app.close();
    }
  });
});
