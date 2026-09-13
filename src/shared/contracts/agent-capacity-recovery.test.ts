/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  agentCapacityRecoveryToolResponse,
  gestaltAgentCapacityRecoveryDynamicTool,
  parseAgentCapacityRecovery,
} from './agent-capacity-recovery.js';

describe('agent capacity recovery contract', () => {
  it('publishes a closed versioned schema', () => {
    expect(gestaltAgentCapacityRecoveryDynamicTool).toMatchObject({
      type: 'function',
      name: 'gestalt_agent_capacity_recovery',
      inputSchema: {
        additionalProperties: false,
        required: ['version', 'reason'],
      },
    });
  });

  it('accepts only the bounded recovery reason', () => {
    expect(parseAgentCapacityRecovery({ version: 1, reason: 'agentThreadLimit' })).toEqual({
      version: 1,
      reason: 'agentThreadLimit',
    });
    expect(parseAgentCapacityRecovery({ version: 1, reason: 'other' })).toBeNull();
    expect(
      parseAgentCapacityRecovery({ version: 1, reason: 'agentThreadLimit', detail: 'transcript' }),
    ).toBeNull();
  });

  it('returns an acknowledgement without runtime or transcript details', () => {
    expect(agentCapacityRecoveryToolResponse()).toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '{"accepted":true,"action":"sessionRuntimeRecycle"}' },
      ],
    });
  });
});
