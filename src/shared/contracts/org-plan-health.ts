/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const gestaltOrgPlanHealthDynamicTool = {
  type: 'function',
  name: 'gestalt_org_plan_health',
  description:
    'Read the current session’s authoritative Org execution health, using the same controller state as Mobile. Read-only; does not enable, resume, checkpoint, or change the Org Plan.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
} as const;

export function isOrgPlanHealthCall(input: { method: string; params: unknown }): boolean {
  if (input.method !== 'item/tool/call' || !input.params || typeof input.params !== 'object')
    return false;
  const params = input.params as Record<string, unknown>;
  return (
    params.tool === gestaltOrgPlanHealthDynamicTool.name &&
    params.arguments !== null &&
    typeof params.arguments === 'object' &&
    !Array.isArray(params.arguments) &&
    Object.keys(params.arguments).length === 0
  );
}
