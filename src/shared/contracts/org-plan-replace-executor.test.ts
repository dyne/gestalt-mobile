/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { parseOrgPlanReplaceExecutorCall } from './org-plan-replace-executor.js';

it('requires explicit user replacement and a canonical task, never a supplied generation', () => {
  const args = { version: 1, reason: 'userDirectedReplacement', canonicalTaskName: 'l3' };
  const call = (arguments_: unknown) =>
    parseOrgPlanReplaceExecutorCall({
      method: 'item/tool/call',
      params: { tool: 'gestalt_org_plan_replace_executor', arguments: arguments_ },
    });
  expect(call(args)).toEqual({ canonicalTaskName: 'l3' });
  for (const invalid of [
    { ...args, version: 2 },
    { ...args, reason: 'routineContinuation' },
    { ...args, canonicalTaskName: 'l3_g2' },
    { ...args, generation: 2 },
    { ...args, canonicalTaskName: 'l0' },
    null,
  ])
    expect(call(invalid)).toBeNull();
});
