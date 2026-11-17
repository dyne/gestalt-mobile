/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const gestaltOrgPlanReplaceExecutorDynamicTool = {
  type: 'function',
  name: 'gestalt_org_plan_replace_executor',
  description:
    'Authorize one physical executor replacement in this supervisor session only when the user explicitly asked for that replacement. That instruction supplies permission; do not request it again. Pass the canonical task name (for example l3), never a generation. Mobile verifies the current plan and stopped writer, persists the replacement and returns its exact identity. Retries return the same pending identity. Resume that task if already present in this root; otherwise spawn it once. Refusal preserves the existing writer. Never use for routine continuation, a new-supervisor takeover, or to bypass attention, Manual Off, or review/model-policy gates.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reason', 'canonicalTaskName'],
    properties: {
      version: { const: 1 },
      reason: { const: 'userDirectedReplacement' },
      canonicalTaskName: { type: 'string', pattern: '^l[1-9][0-9]*$' },
    },
  },
} as const;

export function parseOrgPlanReplaceExecutorCall(input: {
  method: string;
  params: unknown;
}): { canonicalTaskName: string } | null {
  if (input.method !== 'item/tool/call' || !record(input.params)) return null;
  const args = input.params.arguments;
  if (
    input.params.tool !== gestaltOrgPlanReplaceExecutorDynamicTool.name ||
    !record(args) ||
    Object.keys(args).length !== 3 ||
    args.version !== 1 ||
    args.reason !== 'userDirectedReplacement' ||
    typeof args.canonicalTaskName !== 'string' ||
    !/^l[1-9][0-9]*$/.test(args.canonicalTaskName)
  )
    return null;
  return { canonicalTaskName: args.canonicalTaskName };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
