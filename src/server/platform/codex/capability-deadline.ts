/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Shared startup budget; retain the existing environment contract during extraction. */
export function capabilityDeadline(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.XERJ_READY_TIMEOUT_MS);
  return (
    Date.now() +
    (Number.isInteger(configured) && configured >= 100 && configured <= 60_000 ? configured : 5_000)
  );
}

export async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          // Preserve the established error code for existing capability consumers.
          () => reject(new Error('XERJ_READINESS_TIMEOUT')),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
