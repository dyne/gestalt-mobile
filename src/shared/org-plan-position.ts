/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function orgPlanPosition(l1Position: number, l2Position?: number): string {
  return l2Position === undefined ? `L${l1Position}` : `L${l1Position}.${l2Position}`;
}

/** Converts the collaboration API's tool-safe task name into its canonical plan label. */
export function orgPlanAgentDisplayName(name: string): string {
  const match = /^l([1-9]\d*)(?:_([1-9]\d*))?$/.exec(name);
  return match ? orgPlanPosition(Number(match[1]), match[2] ? Number(match[2]) : undefined) : name;
}
