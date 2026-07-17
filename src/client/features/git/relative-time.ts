/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function ageLabel(ageMilliseconds: number): string {
  const minutes = Math.floor(ageMilliseconds / 60_000);
  return minutes < 1 ? 'just now' : `${minutes}m ago`;
}

export function relativeTime(isoTimestamp: string, now = Date.now()): string {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return 'unknown time';
  const seconds = Math.round((timestamp - now) / 1_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, divisor] = units.find(([, value]) => Math.abs(seconds) >= value) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(seconds / divisor),
    unit,
  );
}
