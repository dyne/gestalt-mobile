/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Every reason published by the bundled org-plan helper. */
export const planSignalReasons = [
  'authoring-start',
  'work-start',
  'checkpoint',
  'update',
  'supervision-start',
  'resync',
] as const;

export type PlanSignalReason = (typeof planSignalReasons)[number];

export function isPlanSignalReason(value: unknown): value is PlanSignalReason {
  return typeof value === 'string' && (planSignalReasons as readonly string[]).includes(value);
}
