/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** A local display value only; it never drives a relay request or journal event. */
export function formatLivenessElapsed(updatedAt: string, now: number): string {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return 'Updated recently';
  const seconds = Math.max(0, Math.floor((now - updated) / 1_000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `Updated ${minutes}m ago`;
}
