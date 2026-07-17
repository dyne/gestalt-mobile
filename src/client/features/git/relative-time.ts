/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function ageLabel(ageMilliseconds: number): string {
  const minutes = Math.floor(ageMilliseconds / 60_000);
  return minutes < 1 ? 'just now' : `${minutes}m ago`;
}
