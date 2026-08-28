/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function orgPlanPosition(l1Position: number, l2Position?: number): string {
  return l2Position === undefined ? `L${l1Position}` : `L${l1Position}.${l2Position}`;
}

export type OrgPlanAgentIdentity = Readonly<{
  canonicalTaskName: string;
  canonicalPosition: string;
  generation: number;
}>;

export function parseOrgPlanAgentIdentity(nameOrPath: string): OrgPlanAgentIdentity | null {
  const name = nameOrPath.split('/').filter(Boolean).at(-1) ?? nameOrPath;
  const match = /^(l([1-9]\d*)(?:_([1-9]\d*))?)(?:_g([1-9]\d*))?$/.exec(name);
  if (!match) return null;
  return {
    canonicalTaskName: match[1]!,
    canonicalPosition: orgPlanPosition(Number(match[2]), match[3] ? Number(match[3]) : undefined),
    generation: match[4] ? Number(match[4]) : 1,
  };
}

/** Converts the collaboration API's tool-safe task name into its canonical plan label. */
export function orgPlanAgentDisplayName(name: string): string {
  return parseOrgPlanAgentIdentity(name)?.canonicalPosition ?? name;
}
