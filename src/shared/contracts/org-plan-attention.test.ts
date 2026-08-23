/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import fixture from './fixtures/org-plan-attention-contract.v1.json';
import {
  GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
  gestaltOrgPlanAttentionDynamicTool,
  isOrgPlanAttentionToolResponse,
  parseOrgPlanAttention,
  parseOrgPlanAttentionResponse,
  orgPlanAttentionReasons,
  orgPlanAttentionResumeConditionByReason,
  orgPlanAttentionResumeConditions,
  toOrgPlanAttentionToolResponse,
} from './org-plan-attention.js';

const attention = {
  reason: 'hardBlock',
  summary: 'The required service is unavailable.',
  requestedAction: 'Restore the service or provide an alternative.',
  resumeCondition: 'externalStateChanged',
} as const;

describe('Org Plan attention contract', () => {
  it('exposes one stable, closed dynamic-tool descriptor', () => {
    expect(gestaltOrgPlanAttentionDynamicTool).toEqual({
      type: 'function',
      name: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
      description: expect.stringContaining('error stacks'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['reason', 'summary', 'requestedAction', 'resumeCondition'],
        properties: expect.objectContaining({
          reason: { type: 'string', enum: expect.arrayContaining(['planChange', 'hardBlock']) },
          summary: { type: 'string', minLength: 1, maxLength: 600 },
        }),
        oneOf: expect.any(Array),
      },
    });
  });

  it('accepts only the bounded attention vocabulary and fields', () => {
    expect(parseOrgPlanAttention(attention)).toEqual(attention);
    expect(parseOrgPlanAttention({ ...attention, environment: 'SECRET=value' })).toBeNull();
    expect(parseOrgPlanAttention({ ...attention, reason: 'anythingElse' })).toBeNull();
    expect(parseOrgPlanAttention({ ...attention, summary: 'x'.repeat(601) })).toBeNull();
    expect(parseOrgPlanAttention({ ...attention, resumeCondition: 'later' })).toBeNull();
  });

  it('matches the Gestalt Agents schema-v1 fixture and rejects every cross-pair', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      toolName: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
      reasons: orgPlanAttentionReasons,
      resumeConditions: orgPlanAttentionResumeConditions,
      reasonResumeConditions: orgPlanAttentionResumeConditionByReason,
    });
    expect(gestaltOrgPlanAttentionDynamicTool.inputSchema.oneOf).toEqual(
      orgPlanAttentionReasons.map((reason) => ({
        properties: {
          reason: { const: reason },
          resumeCondition: { const: orgPlanAttentionResumeConditionByReason[reason] },
        },
        required: ['reason', 'resumeCondition'],
      })),
    );
    for (const reason of orgPlanAttentionReasons) {
      const resumeCondition = orgPlanAttentionResumeConditionByReason[reason];
      expect(parseOrgPlanAttention({ ...attention, reason, resumeCondition })).not.toBeNull();
      for (const mismatched of orgPlanAttentionResumeConditions)
        if (mismatched !== resumeCondition)
          expect(
            parseOrgPlanAttention({ ...attention, reason, resumeCondition: mismatched }),
          ).toBeNull();
    }
  });

  it('accepts only bounded human resolution results', () => {
    const response = toOrgPlanAttentionToolResponse({
      action: 'resume',
      guidance: 'Continue now.',
    });
    expect(isOrgPlanAttentionToolResponse(response)).toBe(true);
    expect(parseOrgPlanAttentionResponse({ action: 'disableAutopilot' })).toEqual({
      action: 'disableAutopilot',
    });
    expect(
      parseOrgPlanAttentionResponse({ action: 'resume', guidance: 'x'.repeat(1001) }),
    ).toBeNull();
    expect(parseOrgPlanAttentionResponse({ action: 'resume', stack: 'no' })).toBeNull();
  });
});
