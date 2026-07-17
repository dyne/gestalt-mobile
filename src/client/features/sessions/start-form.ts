/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type StartForm = {
  workspaceId: string;
  profile: string;
  profileState?: 'ok' | 'not_logged_in' | 'error';
};
export function validateStartForm(form: StartForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.workspaceId) errors.workspaceId = 'Choose a workspace.';
  if (!form.profile) errors.profile = 'Choose a profile.';
  if (form.profile && form.profileState && form.profileState !== 'ok')
    errors.profile = 'Sign in to this profile before starting Codex.';
  return errors;
}
