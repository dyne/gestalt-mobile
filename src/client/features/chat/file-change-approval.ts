/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Extracts the app-server file-change targets as plain, safe-to-render text. */
export function readFileChangeApproval(payload: unknown): string[] | null {
  if (!isRecord(payload)) return null;
  const changes = payload.changes;
  if (!Array.isArray(changes)) return null;
  const paths = changes
    .map((change) =>
      isRecord(change) && typeof change.path === 'string' && change.path.trim()
        ? change.path
        : null,
    )
    .filter((path): path is string => path !== null);
  return paths.length === changes.length && paths.length > 0 ? paths : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
