/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const relayMessages = {
  RELAY_UNAVAILABLE: 'The relay is unavailable. Check the connection and try again.',
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
  const code = Object.hasOwn(relayMessages, candidate)
    ? (candidate as RelayFeedbackCode)
    : fallbackCode;
  return { code, message: relayMessages[code] };
}
