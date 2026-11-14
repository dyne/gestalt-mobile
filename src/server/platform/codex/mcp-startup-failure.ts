/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  parseMcpStartupFailure,
  parseMcpStartupStatus,
  startupIdentifier,
  startupServers,
  type McpStartupFailure,
  type McpStartupStatus,
} from '../../../shared/contracts/mcp-startup-failure.js';
import { randomUUID } from 'node:crypto';

export type StartupCorrelation = Pick<McpStartupFailure, 'failureId' | 'attemptId' | 'occurredAt'> &
  Partial<Pick<McpStartupFailure, 'threadId' | 'runtimeId' | 'artifactDigest'>>;

/**
 * Codex 0.164.0 generated experimental schema: McpServerStatusUpdatedNotification.
 * Upstream supplies error prose and one structured failure reason, but no child
 * exit/signal or artifact identity. Never classify prose or treat app-server exit
 * as an MCP child's exit. Legacy Mobile notifications remain compatible.
 */
export function decodeMcpStartupFailure(
  notification: { method?: string; params?: unknown },
  correlation: StartupCorrelation,
): McpStartupFailure | undefined {
  if (
    !['mcpServer/startupStatus/updated', 'mcpServer/statusUpdated'].includes(
      notification.method ?? '',
    ) ||
    !notification.params ||
    typeof notification.params !== 'object' ||
    Array.isArray(notification.params)
  )
    return undefined;
  const params = notification.params as Record<string, unknown>;
  if (params.status !== 'failed' && params.status !== 'cancelled') return undefined;
  return parseMcpStartupFailure({
    ...correlation,
    schemaVersion: 1,
    threadId: params.threadId ?? correlation.threadId,
    serverName: params.name,
    phase: 'startup',
    code:
      params.status === 'cancelled'
        ? 'cancelled'
        : params.failureReason === 'reauthenticationRequired'
          ? 'reauthentication-required'
          : 'startup-failed',
    exitCode: null,
    signal: null,
  });
}

/** Only callers that directly observed this boundary may supply local evidence. */
export function observedMcpStartupFailure(
  correlation: StartupCorrelation,
  observation: Pick<McpStartupFailure, 'serverName'> &
    (
      | { phase: 'artifact'; code: 'artifact-unavailable' }
      | {
          phase: 'spawn' | 'initialize';
          code: 'process-exited';
          exitCode: number | null;
          signal: McpStartupFailure['signal'];
        }
      | { phase: 'initialize'; code: 'protocol-rejected' | 'timeout' }
    ),
): McpStartupFailure | undefined {
  return parseMcpStartupFailure({ ...correlation, ...observation, schemaVersion: 1 });
}

/** Bounded, process-local correlation. No upstream attempt ID is currently exposed. */
export class McpStartupTracker {
  readonly runtimeId = randomUUID();
  private readonly attempts = new Map<string, McpStartupStatus>();

  observe(notification: { method?: string; params?: unknown }): McpStartupStatus | undefined {
    if (
      !['mcpServer/startupStatus/updated', 'mcpServer/statusUpdated'].includes(
        notification.method ?? '',
      ) ||
      !notification.params ||
      typeof notification.params !== 'object' ||
      Array.isArray(notification.params)
    )
      return undefined;
    const params = notification.params as Record<string, unknown>;
    if (!startupServers.includes(params.name as McpStartupFailure['serverName'])) return undefined;
    const status = params.status === 'connected' ? 'ready' : params.status;
    if (!['starting', 'ready', 'failed', 'cancelled'].includes(String(status))) return undefined;
    const threadId = params.threadId == null ? null : startupIdentifier(params.threadId);
    // Invalid identity is not permission to attach a child failure to the root.
    if (params.threadId != null && !threadId) return undefined;
    const key = JSON.stringify([threadId, params.name]);
    const before = this.attempts.get(key);
    if (!before && this.attempts.size >= 256) return undefined;
    if (
      before?.status === status ||
      (before?.failure && (status === 'failed' || status === 'cancelled'))
    )
      return undefined;
    const observedAt = new Date().toISOString();
    const attemptId =
      !before ||
      (status === 'starting' && before.status !== 'starting') ||
      (before.status === 'ready' && (status === 'failed' || status === 'cancelled'))
        ? randomUUID()
        : before.attemptId;
    const failure = decodeMcpStartupFailure(notification, {
      failureId: randomUUID(),
      attemptId,
      occurredAt: observedAt,
      runtimeId: this.runtimeId,
      threadId,
    });
    const observation = parseMcpStartupStatus({
      schemaVersion: 1,
      runtimeId: this.runtimeId,
      attemptId,
      threadId,
      serverName: params.name,
      observedAt,
      status,
      failure: failure ?? null,
    });
    if (observation) this.attempts.set(key, observation);
    return observation;
  }
}
