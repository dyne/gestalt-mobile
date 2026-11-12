/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const relayMessages = {
  SESSION_WORKSPACE_BUSY:
    'A session is already running in this workspace. Open it or stop it first.',
  SESSION_WORKSPACE_CLEANING: 'This workspace is being forgotten. Retry when cleanup finishes.',
  SESSION_NESTED_WORKSPACE: 'Forget the session inside this temporary directory first, then retry.',
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
    'Session history could not be loaded from its provider. Try again shortly; reopen the session if this persists.',
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
  CODEX_MODEL_UNAVAILABLE:
    'The selected Codex model is unavailable. Choose an available model in New session settings and retry.',
  KIMI_MODEL_UNAVAILABLE:
    'The selected Kimi model is unavailable. Choose an available model in New session settings and retry.',
  CODEX_EXECUTOR_MODEL_UNAVAILABLE:
    'The executor model is unavailable. Choose an available executor model in New session settings and retry.',
  WORKSPACE_NOT_FOUND:
    'The selected workspace is no longer available. Select an existing workspace and retry.',
  PROFILE_NOT_FOUND:
    'The selected launcher profile is unavailable. Refresh New session settings and retry.',
  LLM_RUNTIME_UNAVAILABLE:
    'The selected provider runtime is unavailable. Check the provider installation and authentication, then retry.',
  ORG_EXECUTOR_PROFILE_UNAVAILABLE:
    'The Org-plan executor profile could not be read. Restore the installed Gestalt agent profile and try again.',
  ORG_EXECUTOR_PROFILE_INVALID:
    'The Org-plan executor profile has invalid model settings. Repair the installed profile and try again.',
  SESSION_CLOSE_FAILED: 'The session could not be closed. Try again.',
  SESSION_FORGET_FAILED:
    'The session could not be forgotten. It remains in Sessions; try Forget again.',
  SESSION_RELEASE_UNCONFIRMED:
    'Session work could not be stopped. The session is retained; try Forget again.',
  SESSION_CLEANUP_FAILED:
    'Temporary files could not be removed. The session is retained; try Forget again.',
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
  WORKSPACE_FILES_UPLOAD_FAILED: 'The file could not be uploaded. Try dropping it again.',
  WORKSPACE_FOLDER_CREATE_FAILED: 'The folder could not be created. Check the name and try again.',
  WORKSPACE_FOLDER_EXISTS: 'An item with that name already exists. Choose a different folder name.',
  QUIT_FAILED: 'Gestalt Mobile could not quit cleanly. Try again or stop it from the terminal.',
  TMP_CLEANUP_UNAVAILABLE: 'Temporary files could not be checked. Try Clean TMP again.',
  UPGRADE_FAILED:
    'Gestalt could not complete the upgrade and reconnect. Check update-restart.log and reload when Mobile is ready.',
  UPGRADE_UNAVAILABLE: 'Start Mobile with gestalt mobile to enable upgrades.',
  DEBUG_CONTEXT_FAILED: 'Session diagnostics could not be read. Reopen DEBUG to try again.',
  DEBUG_ATTENTION_CHANGED: 'This blocker is no longer active. Refresh the session and try again.',
  DEBUG_CONTEXT_INVALID: 'Select a valid blocker to debug.',
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
  const message =
    fallbackCode === 'SESSION_START_FAILED' && code === 'SESSION_WORKSPACE_UNAVAILABLE'
      ? 'The selected workspace is busy or its temporary ownership could not be confirmed. Retry shortly; if this persists, use Self DEBUG to inspect workspace ownership.'
      : relayMessages[code];
  return { code, message, retryable };
}
