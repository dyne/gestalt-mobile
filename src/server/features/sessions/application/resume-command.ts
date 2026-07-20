/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../model/relay-session.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function buildResumeCommand(
  session: Pick<RelaySessionSnapshot, 'profile' | 'threadId' | 'workspacePath'>,
): string {
  if (!session.threadId) throw new Error('THREAD_REQUIRED');
  return [
    'codex-profile',
    'cli',
    session.profile,
    'resume',
    session.threadId,
    '-C',
    session.workspacePath,
    '--include-non-interactive',
  ]
    .map(quote)
    .join(' ');
}
