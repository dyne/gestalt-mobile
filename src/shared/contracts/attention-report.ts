/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Presentation context only; supervisor prose never changes control authority. */
export function boundedAttentionReport(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  return text.length <= 4_000 ? text : `${text.slice(0, 3_999)}…`;
}
