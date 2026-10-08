/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const relayMessages = {
  FILE_PREVIEW_NOT_FOUND: 'This file or folder no longer exists. Check the path and try again.',
  FILE_PREVIEW_UNREADABLE:
    'This path could not be read. It must be inside the workspace and accessible without symbolic links.',
  FILE_PREVIEW_UNSUPPORTED:
    'Preview supports UTF-8 text files and folders. This item cannot be displayed.',
  FILE_PREVIEW_TOO_LARGE:
    'This file exceeds the 1 MiB preview limit. Open it locally to view its contents.',
  INVALID_FILE_PREVIEW: 'This file reference is invalid. Check its path and try again.',

  RELAY_UNAVAILABLE: 'The relay is unavailable. Check the connection and try again.',
  SESSION_HISTORY_UNAVAILABLE:
    'Session history is unavailable. Check the relay connection and try opening the session again.',
  SESSION_HISTORY_READ_FAILED:
    'Session history could not be read. The conversation remains saved; try again shortly.',
  SESSION_WRITER_BUSY:
    'This thread is active in another Codex client. Release it there, then retry sending here.',
  SESSION_WORKSPACE_UNAVAILABLE:
    'This session workspace is unavailable. Your message remains in the conversation for copying; restore workspace access before sending again.',
  SESSION_RUNTIME_DEPENDENCY_FAILED:
    'A required Codex runtime dependency is unavailable. Check Codex, then retry.',
  CODEX_PROTOCOL_INCOMPATIBLE:
    'The installed Codex runtime is incompatible with this relay. Update Codex before retrying.',
  SESSION_ROLLOUT_MISSING: 'This stored thread is no longer available.',
  SESSION_RUNTIME_UNAVAILABLE: 'The Codex runtime is unavailable. Retry shortly.',
  SESSION_START_FAILED: 'The session could not be started. Try again.',
  ORG_EXECUTOR_PROFILE_UNAVAILABLE:
    'The Org-plan executor profile could not be read. Restore the installed Gestalt agent profile and try again.',
  ORG_EXECUTOR_PROFILE_INVALID:
    'The Org-plan executor profile has invalid model settings. Repair the installed profile and try again.',
  SESSION_CLOSE_FAILED: 'The session could not be closed. Try again.',
  SESSION_COPY_FAILED:
    'The CLI resume command could not be copied. Check clipboard access and try again.',
  SESSION_DEFAULTS_READ_FAILED:
    'Saved session defaults could not be loaded. Using built-in defaults; check the configuration file and reload.',
  SESSION_DEFAULTS_SAVE_FAILED: 'Session defaults could not be saved. Try again.',
  SESSION_MODELS_READ_FAILED:
    'Models could not be loaded for this provider. Select another provider and try again.',
  SESSION_REFRESH_FAILED: 'Sessions could not be refreshed. Try again.',
  MESSAGE_SEND_FAILED: 'The message was not sent. Your draft is preserved.',
  GIT_SUMMARY_FAILED: 'Repository status could not be loaded. Select it again to retry.',
  GIT_PULL_FAILED: 'The branch could not be refreshed. Resolve any Git conflicts and try again.',
  GIT_CHECKOUT_FAILED: 'The branch could not be selected. Refresh Git status and try again.',
  GIT_PUSH_FAILED: 'The push failed. Refresh Git status and resolve remote divergence first.',
  GIT_CLONE_FAILED: 'Clone failed.',
  WORKSPACE_FILES_READ_FAILED: 'Files could not be read. Try again.',
  QUIT_FAILED: 'Gestalt Mobile could not quit cleanly. Try again or stop it from the terminal.',
  UPGRADE_FAILED:
    'Gestalt could not complete the upgrade and reconnect. Check update-restart.log and reload when Mobile is ready.',
  UPGRADE_UNAVAILABLE: 'Start Mobile with gestalt mobile to enable upgrades.',
  DEBUG_CONTEXT_FAILED: 'Session diagnostics could not be read. Reopen DEBUG to try again.',
  DEBUG_START_FAILED:
    'Self DEBUG could not start. Check Sessions for a saved debug session before trying again.',
  DEBUG_TRACE_FAILED:
    'The diagnostic trace could not be opened. Check that the saved JSON file is still available.',
  DEBUG_CONFIRMATION_EXPIRED:
    'The debug confirmation expired. Reopen DEBUG to confirm current session details.',
  DEBUG_SOURCE_CHANGED:
    'The source session changed. Reopen DEBUG to confirm current session details.',
} as const;

export type RelayFeedbackCode = keyof typeof relayMessages;

export function relayFeedback(
  error: unknown,
  fallbackCode: RelayFeedbackCode,
): { code: RelayFeedbackCode; message: string; retryable: boolean } {
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
  const retryable =
    typeof error === 'object' && error !== null && 'retryable' in error
      ? error.retryable === true
      : true;
  return { code, message: relayMessages[code], retryable };
}
