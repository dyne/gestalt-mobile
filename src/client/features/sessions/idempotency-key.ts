/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type RandomUUIDProvider = { randomUUID?: () => string };

export function createIdempotencyKey(
  cryptoApi: RandomUUIDProvider | undefined = globalThis.crypto,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `k-${now().toString(36)}-${Math.floor(random() * 0x100000000).toString(36)}`;
}
