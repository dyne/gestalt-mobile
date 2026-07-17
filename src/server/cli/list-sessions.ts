/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../features/sessions/model/relay-session.js';
import { buildResumeCommand } from '../features/sessions/application/resume-command.js';
export function formatSessions(sessions: RelaySessionSnapshot[]): string {
  if (!sessions.length) return 'No sessions\n';
  return sessions
    .map(
      (session) =>
        `${session.id}\t${session.state}\t${session.profile}\t${session.workspaceId}\t${session.threadId ?? '-'}\n${session.threadId ? buildResumeCommand(session) : ''}`,
    )
    .join('\n');
}
