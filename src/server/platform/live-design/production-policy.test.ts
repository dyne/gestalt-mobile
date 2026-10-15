/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { productionOrgMcpSource } from './production-policy.js';

it('declares the exact canonical Org source inventory without supplying proxy environment values', () => {
  expect(productionOrgMcpSource('/trusted/gestalt')).toEqual({
    name: 'gestalt-org-plan',
    command: 'node',
    args: ['./org-plan-mcp.mjs'],
    cwd: '/trusted/gestalt',
    env_vars: [
      'GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY',
      'GESTALT_MOBILE_ORG_PLAN_STATUS_FILE',
      'GESTALT_MOBILE_ORG_PLAN_CAPABILITIES',
    ],
    default_tools_approval_mode: 'approve',
  });
});
