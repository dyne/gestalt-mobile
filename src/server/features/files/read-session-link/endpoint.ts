/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import {
  linkedLocalFiles,
  localFilePathFromHref,
} from '../../../../shared/contracts/local-file-link.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import { toChatItems, type HistoryTurn } from '../../sessions/get-history/history-mapper.js';
import type { FilePreviewResult } from '../application/ports.js';

/** Files outside the workspace are readable only when linked by this session's assistant. */
export function registerReadSessionLink(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    readHistory(session: RelaySessionSnapshot): Promise<{ turns: HistoryTurn[] }>;
    readWorkspaceFile(root: string, path: string): Promise<FilePreviewResult>;
    readLinkedFile(root: string, path: string): Promise<FilePreviewResult>;
  },
): void {
  app.get('/api/sessions/:id/files/preview', async (request, reply) => {
    const { path } = request.query as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      path.length > 4096 ||
      localFilePathFromHref(path, false) !== path
    )
      return reply.code(400).send({ code: 'INVALID_FILE_PREVIEW' });
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    try {
      const workspacePreview = await deps.readWorkspaceFile(session.workspacePath, path);
      if (workspacePreview.kind === 'available') return reply.send(workspacePreview.preview);
      const history = await deps.readHistory(session);
      const linked = toChatItems(history.turns).some(
        (item) => item.kind === 'agent' && linkedLocalFiles(item.text).includes(path),
      );
      if (!linked) return reply.code(403).send({ code: 'FILE_PREVIEW_NOT_LINKED' });
      const result = await deps.readLinkedFile(session.workspacePath, path);
      if (result.kind === 'available' && result.preview.kind === 'file')
        return reply.send(result.preview);
      const errors = {
        missing: [404, 'FILE_PREVIEW_NOT_FOUND'],
        unreadable: [403, 'FILE_PREVIEW_UNREADABLE'],
        unsupported: [415, 'FILE_PREVIEW_UNSUPPORTED'],
        'too-large': [413, 'FILE_PREVIEW_TOO_LARGE'],
        available: [415, 'FILE_PREVIEW_UNSUPPORTED'],
      } as const;
      const [status, code] = errors[result.kind];
      return reply.code(status).send({ code });
    } catch {
      return reply.code(503).send({ code: 'SESSION_FILE_PREVIEW_UNAVAILABLE' });
    }
  });
}
