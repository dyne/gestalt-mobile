/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Unrelated children must never borrow the relay's ambient owning session. */
export const sessionScratchEnvironmentKeys = [
  'TMPDIR',
  'TMP',
  'TEMP',
  'GESTALT_SESSION_TMP_CONTEXT',
] as const;

export function withoutSessionScratch(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = { ...environment };
  // An ordinary operator TMPDIR may name the host's only executable scratch.
  // Its presence alone is not evidence of owning-session context.
  if (environment.GESTALT_SESSION_TMP_CONTEXT !== undefined)
    for (const key of sessionScratchEnvironmentKeys) delete inherited[key];
  return inherited;
}
