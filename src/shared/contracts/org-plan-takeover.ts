/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const gestaltOrgPlanTakeoverDynamicTool = {
  type: 'function',
  name: 'gestalt_org_plan_takeover',
  description:
    'Take over the current unfinished Org Plan in this new supervisor session when the user explicitly instructed you to take over or continue it here. That instruction supplies authorization; do not ask for another approval or declare a permission blocker. Mobile fences previous supervisors, confirms their writers stopped, preserves checkpoint history, and returns the exact replacement executor identity for this root. Retries return the same pending identity, never a new generation: if that task name already exists in this root, resume it instead of spawning it again. Do not follow up or interrupt an executor belonging to another root. Does not waive review, model-policy, or pending-interaction gates. On failure, report the returned specific recovery code; never launch a competing writer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reason'],
    properties: {
      version: { const: 1 },
      reason: { const: 'userDirectedTakeover' },
    },
  },
} as const;

export function isOrgPlanTakeoverCall(input: { method: string; params: unknown }): boolean {
  if (input.method !== 'item/tool/call' || !record(input.params)) return false;
  const args = input.params.arguments;
  return (
    input.params.tool === gestaltOrgPlanTakeoverDynamicTool.name &&
    record(args) &&
    Object.keys(args).length === 2 &&
    args.version === 1 &&
    args.reason === 'userDirectedTakeover'
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
