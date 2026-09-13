/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Bounded recovery for a Codex collaboration registry whose resident slots leaked. */
export const GESTALT_AGENT_CAPACITY_RECOVERY_TOOL_NAME = 'gestalt_agent_capacity_recovery';

export type AgentCapacityRecovery = Readonly<{
  version: 1;
  reason: 'agentThreadLimit';
}>;

export const gestaltAgentCapacityRecoveryDynamicTool = {
  type: 'function',
  name: GESTALT_AGENT_CAPACITY_RECOVERY_TOOL_NAME,
  description:
    'Recover the current supervised session after Codex reports its agent thread limit and stale pending-init agents cannot be closed. This recycles only the current Codex runtime, preserves the durable root thread and Org Plan, and cannot request human authority.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reason'],
    properties: {
      version: { const: 1 },
      reason: { const: 'agentThreadLimit' },
    },
  },
} as const;

export function parseAgentCapacityRecovery(value: unknown): AgentCapacityRecovery | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  )
    return null;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && candidate.reason === 'agentThreadLimit'
    ? { version: 1, reason: 'agentThreadLimit' }
    : null;
}

export function agentCapacityRecoveryToolResponse(): {
  success: true;
  contentItems: Array<{ type: 'inputText'; text: string }>;
} {
  return {
    success: true,
    contentItems: [
      { type: 'inputText', text: '{"accepted":true,"action":"sessionRuntimeRecycle"}' },
    ],
  };
}
