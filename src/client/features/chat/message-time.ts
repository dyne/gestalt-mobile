/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function formatElapsedAfter(
  previous: number | undefined,
  current: number | undefined,
): string | null {
  if (previous === undefined || current === undefined) return null;
  const minutes = Math.floor(Math.max(0, current - previous) / 60_000);
  if (minutes < 1) return 'moments later';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} later`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} later`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} later`;
}

export function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    timestamp,
  );
}
