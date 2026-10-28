/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { isOrgPlanHealthCall, parseOrgPlanHealthArguments } from './org-plan-health.js';

it('preserves full health and accepts only bounded compact revision requests', () => {
  expect(parseOrgPlanHealthArguments({})).toEqual({ view: 'full' });
  const args = { view: 'compact', sinceRevision: 'a'.repeat(64) };
  expect(parseOrgPlanHealthArguments(args)).toEqual(args);
  expect(
    isOrgPlanHealthCall({
      method: 'item/tool/call',
      params: {
        tool: 'gestalt_org_plan_health',
        arguments: args,
      },
    }),
  ).toBe(true);
  for (const value of [
    null,
    [],
    { view: 'unknown' },
    { sinceRevision: 'a'.repeat(64) },
    { view: 'compact', sinceRevision: 'x'.repeat(65) },
    { view: 'compact', transcript: 'unexpected' },
  ]) {
    expect(parseOrgPlanHealthArguments(value)).toBeNull();
  }
});
