/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { isOrgPlanTakeoverCall } from './org-plan-takeover.js';
it('accepts only the bounded explicit user-directed takeover contract', () => {
  const call = (args: unknown) =>
    isOrgPlanTakeoverCall({
      method: 'item/tool/call',
      params: { tool: 'gestalt_org_plan_takeover', arguments: args },
    });
  expect(call({ version: 1, reason: 'userDirectedTakeover' })).toBe(true);
  for (const args of [
    null,
    {},
    { version: 1, reason: 'automaticRecovery' },
    { version: 1, reason: 'userDirectedTakeover', authorization: 'invented' },
  ])
    expect(call(args)).toBe(false);
});
