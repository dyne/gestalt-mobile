/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const relayMessages = {
  RELAY_UNAVAILABLE: 'The relay is unavailable. Check the connection and try again.',
  SESSION_HISTORY_UNAVAILABLE:
    'Session history is unavailable. Check the relay connection and try opening the session again.',
  SESSION_HISTORY_READ_FAILED:
    'Session history could not be read. The conversation remains saved; try again shortly.',
  SESSION_WRITER_BUSY:
    'This thread is active in another Codex client. Release it there, then retry sending here.',
  SESSION_WORKSPACE_UNAVAILABLE:
    'This session workspace is unavailable. Restore access to it, then retry sending.',
  SESSION_RUNTIME_DEPENDENCY_FAILED:
    'A required Codex runtime dependency is unavailable. Check Codex, then retry.',
  CODEX_PROTOCOL_INCOMPATIBLE:
    'The installed Codex runtime is incompatible with this relay. Update Codex before retrying.',
  SESSION_ROLLOUT_MISSING: 'This stored thread is no longer available.',
  SESSION_RUNTIME_UNAVAILABLE: 'The Codex runtime is unavailable. Retry shortly.',
  SESSION_START_FAILED: 'The session could not be started. Try again.',
  SESSION_REFRESH_FAILED: 'Sessions could not be refreshed. Try again.',
  MESSAGE_SEND_FAILED: 'The message was not sent. Your draft is preserved.',
  GIT_SUMMARY_FAILED: 'Repository status could not be loaded. Select it again to retry.',
  GIT_PULL_FAILED: 'The branch could not be refreshed. Resolve any Git conflicts and try again.',
  GIT_CHECKOUT_FAILED: 'The branch could not be selected. Refresh Git status and try again.',
  GIT_PUSH_FAILED: 'The push failed. Refresh Git status and resolve remote divergence first.',
  GIT_CLONE_FAILED: 'Clone failed.',
} as const;

export type RelayFeedbackCode = keyof typeof relayMessages;

export function relayFeedback(
  error: unknown,
  fallbackCode: RelayFeedbackCode,
): { code: RelayFeedbackCode; message: string } {
  const candidate = error instanceof Error ? error.message : '';
  const problemCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const code = Object.hasOwn(relayMessages, problemCode)
    ? (problemCode as RelayFeedbackCode)
    : Object.hasOwn(relayMessages, candidate)
      ? (candidate as RelayFeedbackCode)
      : fallbackCode;
  return { code, message: relayMessages[code] };
}
