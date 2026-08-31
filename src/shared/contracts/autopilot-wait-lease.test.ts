/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME,
  gestaltAutopilotWaitLeaseDynamicTool,
  parseAutopilotWaitLease,
} from './autopilot-wait-lease.js';

const lease = {
  version: 1,
  reportId: 'report-1',
  leaseId: 'lease-1',
  wakeConditions: ['processExited'],
} as const;

describe('Autopilot wait lease contract', () => {
  it('exposes one closed, bounded dynamic-tool schema', () => {
    expect(gestaltAutopilotWaitLeaseDynamicTool.name).toBe(GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME);
    expect(gestaltAutopilotWaitLeaseDynamicTool.inputSchema.additionalProperties).toBe(false);
    expect(gestaltAutopilotWaitLeaseDynamicTool.inputSchema.required).toEqual([
      'version',
      'reportId',
      'leaseId',
      'wakeConditions',
    ]);
  });

  it('fails closed for malformed, unbounded, or unsupported reports', () => {
    expect(parseAutopilotWaitLease(lease)).toEqual(lease);
    expect(parseAutopilotWaitLease({ ...lease, wakeConditions: [] })).toBeNull();
    expect(parseAutopilotWaitLease({ ...lease, wakeConditions: ['not-observable'] })).toBeNull();
    expect(parseAutopilotWaitLease({ ...lease, transcript: 'wait please' })).toBeNull();
    expect(parseAutopilotWaitLease({ ...lease, reportId: 'x'.repeat(129) })).toBeNull();
  });
});
