/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const eventRetentionMs = 48 * 60 * 60 * 1000;

export function eventRetentionCutoff(occurredAt: string): string | null {
  const timestamp = Date.parse(occurredAt);
  return Number.isFinite(timestamp) ? new Date(timestamp - eventRetentionMs).toISOString() : null;
}
