/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Controlled proof errors only. Never retain URLs, cookie values or bearer-shaped strings. */
export function safeBrowserFailure(message) {
  return String(message ?? '')
    .split('\n')[0]
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[url]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 500);
}
