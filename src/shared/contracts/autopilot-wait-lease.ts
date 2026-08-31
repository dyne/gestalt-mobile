/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME = 'gestalt_autopilot_wait_lease';
export const autopilotWaitWakeConditions = [
  'planChanged',
  'reviewChanged',
  'checkpointChanged',
  'interactionChanged',
  'executorChanged',
  'processExited',
  'processResultAvailable',
  'processLimitBreached',
  'agentActivityChanged',
] as const;
export type AutopilotWaitWakeCondition = (typeof autopilotWaitWakeConditions)[number];

export type AutopilotWaitLease = Readonly<{
  version: 1;
  reportId: string;
  leaseId: string;
  wakeConditions: readonly AutopilotWaitWakeCondition[];
}>;

export const gestaltAutopilotWaitLeaseDynamicTool = {
  type: 'function',
  name: GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME,
  description:
    'Register a bounded observable wait for the current supervised session after an Autopilot probe. This cannot request human authority and never accepts transcript prose.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reportId', 'leaseId', 'wakeConditions'],
    properties: {
      version: { const: 1 },
      reportId: { type: 'string', minLength: 1, maxLength: 128 },
      leaseId: { type: 'string', minLength: 1, maxLength: 128 },
      wakeConditions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { type: 'string', enum: autopilotWaitWakeConditions },
      },
    },
  },
} as const;

export function parseAutopilotWaitLease(value: unknown): AutopilotWaitLease | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.version !== 1) return null;
  if (!bounded(value.reportId) || !bounded(value.leaseId) || !Array.isArray(value.wakeConditions))
    return null;
  const wakeConditions = value.wakeConditions;
  if (
    wakeConditions.length < 1 ||
    wakeConditions.length > 4 ||
    new Set(wakeConditions).size !== wakeConditions.length ||
    !wakeConditions.every(
      (condition): condition is AutopilotWaitWakeCondition =>
        typeof condition === 'string' &&
        (autopilotWaitWakeConditions as readonly string[]).includes(condition),
    )
  )
    return null;
  return { version: 1, reportId: value.reportId, leaseId: value.leaseId, wakeConditions };
}

export function autopilotWaitLeaseToolResponse(): {
  success: true;
  contentItems: Array<{ type: 'inputText'; text: string }>;
} {
  return { success: true, contentItems: [{ type: 'inputText', text: '{"accepted":true}' }] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
