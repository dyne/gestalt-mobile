/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Versioned, bounded contract consumed by supervised Org Plan roles. */
export const GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME = 'gestalt_org_plan_attention';

export const orgPlanAttentionReasons = [
  'planChange',
  'hardBlock',
  'missingDependency',
  'permissionRequired',
  'externalState',
  'materialAmbiguity',
] as const;
export type OrgPlanAttentionReason = (typeof orgPlanAttentionReasons)[number];

export const orgPlanAttentionResumeConditions = [
  'userGuidance',
  'planRevision',
  'dependencyInstalled',
  'permissionGranted',
  'externalStateChanged',
] as const;
export type OrgPlanAttentionResumeCondition = (typeof orgPlanAttentionResumeConditions)[number];

export const orgPlanAttentionResumeConditionByReason = {
  planChange: 'planRevision',
  hardBlock: 'externalStateChanged',
  missingDependency: 'dependencyInstalled',
  permissionRequired: 'permissionGranted',
  externalState: 'externalStateChanged',
  materialAmbiguity: 'userGuidance',
} as const satisfies Record<OrgPlanAttentionReason, OrgPlanAttentionResumeCondition>;

export type OrgPlanAttention = Readonly<{
  reason: OrgPlanAttentionReason;
  summary: string;
  requestedAction: string;
  resumeCondition: OrgPlanAttentionResumeCondition;
}>;

export type OrgPlanAttentionResponse = Readonly<{
  action: 'resume' | 'disableAutopilot';
  guidance?: string;
}>;

export const gestaltOrgPlanAttentionDynamicTool = {
  type: 'function',
  name: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
  description:
    'Declare a genuine, durable human-attention requirement for a supervised Org Plan. Use only when progress cannot continue safely without the requested bounded human action. Do not include error stacks, environment values, plan contents, or unbounded prose.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'summary', 'requestedAction', 'resumeCondition'],
    properties: {
      reason: { type: 'string', enum: orgPlanAttentionReasons },
      summary: { type: 'string', minLength: 1, maxLength: 600 },
      requestedAction: { type: 'string', minLength: 1, maxLength: 600 },
      resumeCondition: { type: 'string', enum: orgPlanAttentionResumeConditions },
    },
    oneOf: orgPlanAttentionReasons.map((reason) => ({
      properties: {
        reason: { const: reason },
        resumeCondition: { const: orgPlanAttentionResumeConditionByReason[reason] },
      },
      required: ['reason', 'resumeCondition'],
    })),
  },
} as const;

export function parseOrgPlanAttention(value: unknown): OrgPlanAttention | null {
  if (!isRecord(value) || Object.keys(value).length !== 4) return null;
  if (
    !isReason(value.reason) ||
    !isBoundedText(value.summary, 600) ||
    !isBoundedText(value.requestedAction, 600) ||
    !isResumeCondition(value.resumeCondition) ||
    orgPlanAttentionResumeConditionByReason[value.reason] !== value.resumeCondition
  )
    return null;
  return {
    reason: value.reason,
    summary: value.summary,
    requestedAction: value.requestedAction,
    resumeCondition: value.resumeCondition,
  };
}

export function parseOrgPlanAttentionResponse(value: unknown): OrgPlanAttentionResponse | null {
  if (!isRecord(value) || !['resume', 'disableAutopilot'].includes(value.action as string))
    return null;
  if (Object.keys(value).some((key) => key !== 'action' && key !== 'guidance')) return null;
  if (value.guidance !== undefined && !isBoundedText(value.guidance, 1_000)) return null;
  return {
    action: value.action as OrgPlanAttentionResponse['action'],
    ...(typeof value.guidance === 'string' ? { guidance: value.guidance } : {}),
  };
}

/** The only result accepted by the held app-server dynamic-tool request. */
export function toOrgPlanAttentionToolResponse(response: OrgPlanAttentionResponse): {
  contentItems: Array<{ type: 'input_text'; text: string }>;
  success: true;
} {
  return {
    success: true,
    contentItems: [{ type: 'input_text', text: JSON.stringify(response) }],
  };
}

export function isOrgPlanAttentionToolResponse(value: unknown): boolean {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.contentItems))
    return false;
  const item = value.contentItems[0];
  if (
    value.contentItems.length !== 1 ||
    !isRecord(item) ||
    item.type !== 'input_text' ||
    typeof item.text !== 'string'
  )
    return false;
  try {
    return parseOrgPlanAttentionResponse(JSON.parse(item.text)) !== null;
  } catch {
    return false;
  }
}

function isReason(value: unknown): value is OrgPlanAttentionReason {
  return (
    typeof value === 'string' && (orgPlanAttentionReasons as readonly string[]).includes(value)
  );
}
function isResumeCondition(value: unknown): value is OrgPlanAttentionResumeCondition {
  return (
    typeof value === 'string' &&
    (orgPlanAttentionResumeConditions as readonly string[]).includes(value)
  );
}
function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
