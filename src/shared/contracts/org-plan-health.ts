/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const gestaltOrgPlanHealthDynamicTool = {
  type: 'function',
  name: 'gestalt_org_plan_health',
  description:
    'Read Org health and reconcile observed executor ownership without starting work or enabling Autopilot. Prefer view:compact for combined plan, activity, executor, test-run and wait state. Supply its revision as sinceRevision to receive only changed sections or unchanged:true. A missing/expired revision returns a full compact snapshot. Omit view for detailed launch/model-policy evidence. Never changes the Org Plan or clears attention.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view: { type: 'string', enum: ['full', 'compact'] },
      sinceRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  },
} as const;

export function parseOrgPlanHealthArguments(
  value: unknown,
): { view: 'full' | 'compact'; sinceRevision?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !['view', 'sinceRevision'].includes(key))) return null;
  if (args.view !== undefined && args.view !== 'full' && args.view !== 'compact') return null;
  if (
    args.sinceRevision !== undefined &&
    (args.view !== 'compact' ||
      typeof args.sinceRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(args.sinceRevision))
  )
    return null;
  return {
    view: args.view === 'compact' ? 'compact' : 'full',
    ...(typeof args.sinceRevision === 'string' ? { sinceRevision: args.sinceRevision } : {}),
  };
}

export function isOrgPlanHealthCall(input: { method: string; params: unknown }): boolean {
  if (input.method !== 'item/tool/call' || !input.params || typeof input.params !== 'object')
    return false;
  const params = input.params as Record<string, unknown>;
  return (
    params.tool === gestaltOrgPlanHealthDynamicTool.name &&
    parseOrgPlanHealthArguments(params.arguments) !== null
  );
}
