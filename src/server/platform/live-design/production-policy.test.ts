/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { assertUnadmittedLiveMcp, productionOrgMcpSource } from './production-policy.js';

it('requires terminal empty owning MCP refusals before publishing source seal or receipts', () => {
  const servers = ['context-mode', 'gestalt-org-plan'].map((name) => ({
    name,
    runtimeStatus: 'failed',
    tools: {},
    httpOrigin: null,
  }));
  expect(() => assertUnadmittedLiveMcp({ data: servers, nextCursor: null })).not.toThrow();
  for (const runtimeStatus of ['starting', 'notStarted', 'connected', 'cancelled', null])
    expect(() =>
      assertUnadmittedLiveMcp({
        data: [{ ...servers[0], runtimeStatus }, servers[1]],
        nextCursor: null,
      }),
    ).toThrow('LIVE_PRESEAL_MCP_UNVERIFIED');
  for (const data of [
    [],
    [servers[0]],
    [servers[0], { ...servers[1], name: 'unapproved' }],
    [{ ...servers[0], tools: { unsafe: {} } }, servers[1]],
  ])
    expect(() => assertUnadmittedLiveMcp({ data, nextCursor: null })).toThrow(
      'LIVE_PRESEAL_MCP_UNVERIFIED',
    );
});

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
