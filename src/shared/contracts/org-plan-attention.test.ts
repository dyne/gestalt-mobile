/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
  gestaltOrgPlanAttentionDynamicTool,
  isOrgPlanAttentionToolResponse,
  parseOrgPlanAttention,
  parseOrgPlanAttentionResponse,
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
