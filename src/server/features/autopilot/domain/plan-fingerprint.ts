/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Inspectable serialized plan state, not an identifier. Preserve bytes for comparisons.
 * Legacy opaque fingerprints remain readable; new producers emit serialized JSON.
 * The aggregate record budget also bounds repeated fingerprints in command history.
 */
export const MAX_PLAN_FINGERPRINT_BYTES = 64 * 1024;
export const MAX_AUTOPILOT_RECORD_BYTES = 1024 * 1024;

export function parsePlanFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_PLAN_FINGERPRINT_BYTES
    ? value
    : undefined;
}

export function requirePlanFingerprint(value: string): string {
  const parsed = parsePlanFingerprint(value);
  if (parsed === undefined) throw new Error('AUTOPILOT_FINGERPRINT_INVALID');
  return parsed;
}
