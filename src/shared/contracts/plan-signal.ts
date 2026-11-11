/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Helper publications and Mobile's display-only attachment signal. */
export const planSignalReasons = [
  'authoring-start',
  'display-open',
  'work-start',
  'checkpoint',
  'update',
  'supervision-start',
  'resync',
] as const;

export type PlanSignalReason =
  | (typeof planSignalReasons)[number]
  | `review:${string}:REVIEWED`
  | `measure:${'start' | 'checkpoint' | 'finish'}:${string}`
  | `l2:${string}:${'WIP' | 'DONE'}`;

export function isPlanSignalReason(value: unknown): value is PlanSignalReason {
  return (
    typeof value === 'string' &&
    ((planSignalReasons as readonly string[]).includes(value) ||
      /^review:[A-Za-z0-9._-]{1,128}:REVIEWED$/.test(value) ||
      /^measure:(start|checkpoint|finish):[A-Za-z0-9._-]{1,128}$/.test(value) ||
      /^l2:[A-Za-z0-9._-]{1,128}:(WIP|DONE)$/.test(value))
  );
}
