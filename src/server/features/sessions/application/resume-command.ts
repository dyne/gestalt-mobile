import type { RelaySessionSnapshot } from '../model/relay-session.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function buildResumeCommand(session: RelaySessionSnapshot): string {
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
