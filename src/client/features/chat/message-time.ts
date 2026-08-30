/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function formatElapsedAfter(
  previous: number | undefined,
  current: number | undefined,
): string | null {
  if (
    previous === undefined ||
    current === undefined ||
    !Number.isFinite(previous) ||
    !Number.isFinite(current)
  )
    return null;
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

export function formatRelativeAge(timestamp: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - timestamp) / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
