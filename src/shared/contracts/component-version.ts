/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ComponentVersion = Readonly<{
  id: 'gestalt' | 'gestalt-mobile' | 'gestalt-agents' | 'context-mode' | 'codex';
  label: string;
  version: string | null;
}>;
