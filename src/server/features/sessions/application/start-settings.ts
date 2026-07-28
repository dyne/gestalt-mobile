/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** The relay's configured default, kept explicit so deployments can change it centrally later. */
export const DEFAULT_SESSION_MODEL = 'gpt-5.6-terra';

/** Settings accepted by Codex's generated thread/start contract. */
export type StartSessionSettings = {
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
};
