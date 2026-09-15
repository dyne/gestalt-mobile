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
export const AUTOPILOT_WAIT_MIN_MS = 60_000;
export const AUTOPILOT_WAIT_MAX_MS = 86_400_000;

type AutopilotWaitLeaseBase = Readonly<{
  reportId: string;
  leaseId: string;
  wakeConditions: readonly AutopilotWaitWakeCondition[];
}>;

export type AutopilotWaitLease =
  | (AutopilotWaitLeaseBase & Readonly<{ version: 1 }>)
  | (AutopilotWaitLeaseBase & Readonly<{ version: 2; maxWaitMs: number }>);

export const gestaltAutopilotWaitLeaseDynamicTool = {
  type: 'function',
  name: GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME,
  description:
    'Register one non-persistent Autopilot wait episode for the current supervised session. Version 2 may be called proactively for known long work and resumes on the first requested event or bounded maxWaitMs deadline; call it again in a later turn only if another long wait is justified. This cannot request human authority and never accepts transcript prose.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reportId', 'leaseId', 'wakeConditions'],
    properties: {
      version: { type: 'integer', enum: [1, 2] },
      reportId: { type: 'string', minLength: 1, maxLength: 128 },
      leaseId: { type: 'string', minLength: 1, maxLength: 128 },
      wakeConditions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { type: 'string', enum: autopilotWaitWakeConditions },
      },
      maxWaitMs: {
        type: 'integer',
        minimum: AUTOPILOT_WAIT_MIN_MS,
        maximum: AUTOPILOT_WAIT_MAX_MS,
        description:
          'Version 2 safety deadline in milliseconds. An observable wake resumes earlier.',
      },
    },
  },
} as const;

export function parseAutopilotWaitLease(value: unknown): AutopilotWaitLease | null {
  if (!record(value) || (value.version !== 1 && value.version !== 2)) return null;
  const expectedKeys = value.version === 1 ? 4 : 5;
  if (Object.keys(value).length !== expectedKeys) return null;
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
  if (value.version === 1)
    return { version: 1, reportId: value.reportId, leaseId: value.leaseId, wakeConditions };
  if (
    !Number.isSafeInteger(value.maxWaitMs) ||
    (value.maxWaitMs as number) < AUTOPILOT_WAIT_MIN_MS ||
    (value.maxWaitMs as number) > AUTOPILOT_WAIT_MAX_MS
  )
    return null;
  return {
    version: 2,
    reportId: value.reportId,
    leaseId: value.leaseId,
    wakeConditions,
    maxWaitMs: value.maxWaitMs as number,
  };
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
