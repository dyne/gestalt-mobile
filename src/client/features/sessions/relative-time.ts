/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return 'Unknown activity time';
  const elapsed = Math.max(0, now - timestamp);
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours < 1) return 'Less than an hour ago';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
