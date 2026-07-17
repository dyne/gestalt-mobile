/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type IdempotentResponse = { statusCode: number; body: string };
export function idempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value : null;
}
