/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import {
  assertAdmittedLiveMcp,
  assertOriginalLiveMcp,
  installedMcpBudgets,
  LIVE_CONTEXT_TOOL_NAMES,
  LIVE_ORG_TOOL_NAMES,
  ORIGINAL_CONTEXT_TOOL_NAMES,
  originalInstalledSourceSchema,
  originalLaunchSurfaces,
} from './installed-launch-contract.js';

const source = originalInstalledSourceSchema.parse({
  kind: 'context-mode-bridge-v1',
  path: '/home/owner/bin/context-mode-mcp.mjs',
  sha256: 'a'.repeat(64),
  gestaltHome: '/home/gestalt',
  interpreter: { path: '/usr/bin/node', sha256: 'b'.repeat(64) },
  package: { root: '/cache/context-mode/2.16.1', version: '2.16.1', treeDigest: 'c'.repeat(64) },
  runtime: { root: '/home/gestalt/runtime/context-mode', treeDigest: 'd'.repeat(64) },
});
const server = (name: string, names: readonly string[]) => ({
  name,
  runtimeStatus: 'connected',
  toolsError: null,
  httpOrigin: null,
  tools: Object.fromEntries(names.map((name) => [name, { name, inputSchema: {} }])),
});

it('requires exact owning tool surfaces after seal, including every resumed generation', () => {
  const context = server('context-mode', LIVE_CONTEXT_TOOL_NAMES);
  const org = server('gestalt-org-plan', LIVE_ORG_TOOL_NAMES);
  const catalog = (data: unknown[]) => ({ data, nextCursor: null });
  expect(() => assertAdmittedLiveMcp(catalog([context, org]))).not.toThrow();
  for (const data of [
    [context],
    [context, context],
    [context, { ...org, runtimeStatus: 'starting' }],
    [server('context-mode', ORIGINAL_CONTEXT_TOOL_NAMES), org],
    [server('context-mode', LIVE_CONTEXT_TOOL_NAMES.slice(1)), org],
    [context, server('gestalt-org-plan', [...LIVE_ORG_TOOL_NAMES, 'unknown'])],
    [{ ...context, toolsError: 'failure' }, org],
    [context, { ...org, httpOrigin: 'https://external' }],
  ])
    expect(() => assertAdmittedLiveMcp(catalog(data))).toThrow('LIVE_MCP_UNAVAILABLE');
  expect(() => assertAdmittedLiveMcp({ data: [context, org], nextCursor: 'extra' })).toThrow();
});

it('binds an original catalog to its declared executable surface without invoking its tools', () => {
  const original = {
    data: [server('context-mode', ORIGINAL_CONTEXT_TOOL_NAMES)],
    nextCursor: null,
  };
  expect(() => assertOriginalLiveMcp(original, source)).not.toThrow();
  expect(() => assertOriginalLiveMcp(original)).toThrow('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  expect(() => assertOriginalLiveMcp({ data: [], nextCursor: null }, source)).toThrow();
  expect(() =>
    assertOriginalLiveMcp({ ...original, data: [...original.data, server('other', [])] }, source),
  ).toThrow();
  expect(() =>
    assertOriginalLiveMcp(
      { data: [server('context-mode', LIVE_CONTEXT_TOOL_NAMES)], nextCursor: null },
      source,
    ),
  ).toThrow();
  expect(originalLaunchSurfaces(source)).toMatchObject({
    mcpServers: {
      'context-mode': { command: 'node', args: [source.path], enabled: true, required: true },
    },
    plugins: { 'context-mode@dyne-gestalt-agents': { enabled: false } },
  });
  expect(() => originalInstalledSourceSchema.parse({ ...source, env: {} })).toThrow();
  expect(() => originalInstalledSourceSchema.parse({ ...source, kind: 'instruction' })).toThrow();
});

it('uses the accepted observation, command and startup phase budgets only for installed sources', () => {
  expect(installedMcpBudgets('context-mode', true)).toEqual({
    startup_timeout_sec: 880,
    tool_timeout_sec: 395,
  });
  expect(installedMcpBudgets('gestalt-org-plan', true)).toEqual({
    startup_timeout_sec: 270,
    tool_timeout_sec: 90,
  });
  expect(installedMcpBudgets('context-mode', false)).toEqual({});
});
