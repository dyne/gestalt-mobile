/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { orgPlanAgentDisplayName, orgPlanPosition } from './org-plan-position.js';

describe('Org Plan positions', () => {
  it('formats L1 and nested L2 positions canonically', () => {
    expect(orgPlanPosition(2)).toBe('L2');
    expect(orgPlanPosition(2, 5)).toBe('L2.5');
  });

  it('presents exact L1 executor names and replacement generations canonically', () => {
    expect(orgPlanAgentDisplayName('l2')).toBe('L2');
    expect(orgPlanAgentDisplayName('/root/l4_g2')).toBe('L4');
    expect(orgPlanAgentDisplayName('l2_5')).toBe('l2_5');
    expect(orgPlanAgentDisplayName('l2_5_g3')).toBe('l2_5_g3');
    expect(orgPlanAgentDisplayName('researcher')).toBe('researcher');
    expect(orgPlanAgentDisplayName('l0_2')).toBe('l0_2');
  });
});
