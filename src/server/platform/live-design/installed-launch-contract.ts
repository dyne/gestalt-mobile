/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { LiveApprovedLaunchSurfaces } from './effective-config.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pin = z.object({ path: z.string(), sha256: digest }).strict();
/** Executable provenance is distinct from private config/instruction inventory. */
export const originalInstalledSourceSchema = z
  .object({
    kind: z.literal('context-mode-bridge-v1'),
    path: z.string(),
    sha256: digest,
    gestaltHome: z.string(),
    interpreter: pin,
    package: z
      .object({
        root: z.string(),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        treeDigest: digest,
      })
      .strict(),
    runtime: z.object({ root: z.string(), treeDigest: digest }).strict(),
  })
  .strict();
export type OriginalInstalledSource = z.infer<typeof originalInstalledSourceSchema>;
export type InstalledSourceObservation = Readonly<{
  kind: 'installed-launch-source';
  descriptor: OriginalInstalledSource;
  observation: Readonly<Record<string, unknown>>;
}>;

export const ORIGINAL_INSTALLED_SOURCE_EXTENSION = 'original-installed-launch-source-v1';
export const LIVE_MANAGER_OBSERVATION_MS = 90_000;
const contextExecutionMs = 120_000 + 2 * LIVE_MANAGER_OBSERVATION_MS + 5_000;
/** Match the accepted Agents phase budgets, rather than a caller supplied wait. */
export function installedMcpBudgets(server: string, installed: boolean) {
  if (!installed) return {};
  const dispatch =
    LIVE_MANAGER_OBSERVATION_MS + (server === 'context-mode' ? contextExecutionMs : 0);
  return {
    startup_timeout_sec: (LIVE_MANAGER_OBSERVATION_MS + 2 * dispatch) / 1000,
    tool_timeout_sec: dispatch / 1000,
  };
}
export const LIVE_OWNING_CATALOG_MS =
  installedMcpBudgets('context-mode', true).startup_timeout_sec! * 1000 + 5_000;

/** Only the independently bound original bridge is currently supported. Enabled
 * package hooks/other plugin surfaces remain unavailable, never silently disabled. */
export function originalLaunchSurfaces(
  source?: OriginalInstalledSource,
  originalPlugins?: unknown,
): LiveApprovedLaunchSurfaces {
  const plugins = source ? { 'context-mode@dyne-gestalt-agents': { enabled: false } } : {};
  const disabledInstalled = {
    ...plugins,
    'gestalt@dyne-gestalt-agents': { enabled: false },
  };
  // Native 9790114 returns disabled plugins before loading any capability or
  // manifest. This exact inert metadata still belongs to the signed original
  // config; never introduce it, enable it, or accept custom plugin fields.
  if (
    originalPlugins !== undefined &&
    !isDeepStrictEqual(originalPlugins, plugins) &&
    !(source && isDeepStrictEqual(originalPlugins, disabledInstalled))
  )
    throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
  return source
    ? {
        mcpServers: {
          'context-mode': {
            command: 'node',
            args: [source.path],
            enabled: true,
            required: true,
            default_tools_approval_mode: 'approve',
          },
        },
        plugins: structuredClone(originalPlugins ?? plugins) as Record<string, unknown>,
      }
    : { mcpServers: {}, plugins: {} };
}

export const LIVE_CONTEXT_TOOL_NAMES = [
  'ctx_execute',
  'ctx_execute_file',
  'ctx_batch_execute',
  'ctx_index',
  'ctx_search',
  'ctx_stats',
  'ctx_purge',
] as const;
export const ORIGINAL_CONTEXT_TOOL_NAMES = [
  ...LIVE_CONTEXT_TOOL_NAMES,
  'ctx_fetch_and_index',
  'ctx_doctor',
  'ctx_upgrade',
  'ctx_insight',
] as const;
export const LIVE_ORG_TOOL_NAMES = [
  'org_plan_validate',
  'org_plan_summary',
  'org_plan_describe',
  'org_plan_next',
  'org_plan_projection',
  'org_plan_l1_transition',
  'org_plan_l2_transition',
  'org_plan_review_transition',
  'org_plan_signal',
  'org_plan_measure',
  'org_plan_suspend_reopen',
  'org_plan_resume',
] as const;

/** This consumes the actual owning-thread catalog, never a proxy tools/list. */
export function assertAdmittedLiveMcp(value: unknown): void {
  const mcp = value as {
    data?: {
      name?: unknown;
      runtimeStatus?: unknown;
      tools?: unknown;
      toolsError?: unknown;
      httpOrigin?: unknown;
    }[];
    nextCursor?: unknown;
  } | null;
  if (
    !mcp ||
    !Array.isArray(mcp.data) ||
    mcp.data.length !== 2 ||
    mcp.nextCursor !== null ||
    !isDeepStrictEqual(mcp.data.map((s) => s?.name).sort(), ['context-mode', 'gestalt-org-plan']) ||
    mcp.data.some(
      (s) =>
        !s ||
        s.runtimeStatus !== 'connected' ||
        s.toolsError ||
        s.httpOrigin ||
        !s.tools ||
        typeof s.tools !== 'object' ||
        Array.isArray(s.tools) ||
        !isDeepStrictEqual(
          Object.keys(s.tools).sort(),
          [...(s.name === 'context-mode' ? LIVE_CONTEXT_TOOL_NAMES : LIVE_ORG_TOOL_NAMES)].sort(),
        ),
    )
  )
    throw new Error('LIVE_MCP_UNAVAILABLE');
}

export function assertOriginalLiveMcp(value: unknown, source?: OriginalInstalledSource): void {
  const mcp = value as {
    data?: {
      name?: unknown;
      runtimeStatus?: unknown;
      tools?: unknown;
      toolsError?: unknown;
      httpOrigin?: unknown;
    }[];
    nextCursor?: unknown;
  } | null;
  if (!mcp || !Array.isArray(mcp.data) || mcp.nextCursor !== null)
    throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  if (!source) {
    if (mcp.data.length) throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
    return;
  }
  const server = mcp.data[0];
  if (
    mcp.data.length !== 1 ||
    server?.name !== 'context-mode' ||
    server.runtimeStatus !== 'connected' ||
    server.toolsError ||
    server.httpOrigin ||
    !server.tools ||
    typeof server.tools !== 'object' ||
    Array.isArray(server.tools) ||
    !isDeepStrictEqual(Object.keys(server.tools).sort(), [...ORIGINAL_CONTEXT_TOOL_NAMES].sort())
  )
    throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
}
