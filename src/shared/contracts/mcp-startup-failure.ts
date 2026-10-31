/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { parseXerjStartupReason, type XerjStartupReason } from './xerj-startup.js';

export const startupServers = [
  'context-mode',
  'gestalt-context-mode',
  'gestalt-serena',
  'gestalt-xerj',
] as const;
export const startupPhases = ['artifact', 'spawn', 'initialize', 'startup', 'readiness'] as const;
export const startupFailureCodes = [
  'artifact-unavailable',
  'process-exited',
  'protocol-rejected',
  'timeout',
  'reauthentication-required',
  'startup-failed',
  'cancelled',
  'readiness-failed',
] as const;
const signals = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGABRT',
  'SIGKILL',
  'SIGSEGV',
  'SIGTERM',
] as const;

/** Structural evidence only. Null means unavailable, including upstream child telemetry. */
export type McpStartupFailure = Readonly<{
  schemaVersion: 1;
  failureId: string;
  attemptId: string;
  occurredAt: string;
  threadId: string | null;
  serverName: (typeof startupServers)[number];
  phase: (typeof startupPhases)[number];
  code: (typeof startupFailureCodes)[number];
  runtimeId: string | null;
  artifactDigest: string | null;
  exitCode: number | null;
  signal: (typeof signals)[number] | null;
  readinessReason?: XerjStartupReason;
}>;

export function startupIdentifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : null;
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function utcTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
    ? value
    : undefined;
}

/** Reconstruct the allowlist on every persistence/export boundary; never spread input. */
export function parseMcpStartupFailure(value: unknown): McpStartupFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const failureId = startupIdentifier(r.failureId);
  const attemptId = startupIdentifier(r.attemptId);
  const occurredAt = utcTimestamp(r.occurredAt);
  if (
    r.schemaVersion !== 1 ||
    !failureId ||
    !attemptId ||
    !occurredAt ||
    !member(startupServers, r.serverName) ||
    !member(startupPhases, r.phase) ||
    !member(startupFailureCodes, r.code)
  )
    return undefined;
  if (
    (r.phase === 'readiness' || r.code === 'readiness-failed') &&
    !(r.phase === 'readiness' && r.code === 'readiness-failed' && r.serverName === 'gestalt-xerj')
  )
    return undefined;
  return {
    schemaVersion: 1,
    failureId,
    attemptId,
    occurredAt,
    threadId: startupIdentifier(r.threadId),
    serverName: r.serverName,
    phase: r.phase,
    code: r.code,
    runtimeId: startupIdentifier(r.runtimeId),
    artifactDigest:
      typeof r.artifactDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(r.artifactDigest)
        ? r.artifactDigest
        : null,
    exitCode:
      typeof r.exitCode === 'number' &&
      Number.isInteger(r.exitCode) &&
      r.exitCode >= 0 &&
      r.exitCode <= 255
        ? r.exitCode
        : null,
    signal: member(signals, r.signal) ? r.signal : null,
    ...(r.phase === 'readiness' && r.code === 'readiness-failed' && r.serverName === 'gestalt-xerj'
      ? { readinessReason: parseXerjStartupReason(r.readinessReason) }
      : {}),
  };
}

/** Relay-scoped app-server lifetime and observed attempt; neither is issued by Codex. */
export type McpStartupStatus = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  attemptId: string;
  threadId: string | null;
  serverName: McpStartupFailure['serverName'];
  observedAt: string;
  status: 'starting' | 'ready' | 'failed' | 'cancelled';
  failure: McpStartupFailure | null;
  /** Local backend preparation, before any Codex MCP child is configured. */
  phase?: 'readiness';
}>;

export function parseMcpStartupStatus(value: unknown): McpStartupStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const runtimeId = startupIdentifier(r.runtimeId);
  const attemptId = startupIdentifier(r.attemptId);
  const threadId = r.threadId === null ? null : startupIdentifier(r.threadId);
  const observedAt = utcTimestamp(r.observedAt);
  if (
    r.schemaVersion !== 1 ||
    !runtimeId ||
    !attemptId ||
    !observedAt ||
    (r.threadId !== null && !threadId) ||
    !member(startupServers, r.serverName) ||
    !member(['starting', 'ready', 'failed', 'cancelled'], r.status)
  )
    return undefined;
  const failure = parseMcpStartupFailure(r.failure);
  if (
    r.status === 'failed' || r.status === 'cancelled'
      ? !failure ||
        failure.runtimeId !== runtimeId ||
        failure.attemptId !== attemptId ||
        failure.threadId !== threadId ||
        failure.serverName !== r.serverName ||
        failure.occurredAt !== r.observedAt ||
        (r.status === 'cancelled') !== (failure.code === 'cancelled')
      : r.failure !== null
  )
    return undefined;
  return {
    schemaVersion: 1,
    runtimeId,
    attemptId,
    threadId,
    serverName: r.serverName,
    observedAt,
    status: r.status as McpStartupStatus['status'],
    failure: failure ?? null,
    ...(r.phase === 'readiness' && r.serverName === 'gestalt-xerj'
      ? { phase: 'readiness' as const }
      : {}),
  };
}

/** One current row per physical thread/tool; unattributed lifetimes stay separate. */
export function mcpStartupActivity(status: McpStartupStatus) {
  return {
    id: `mcp-startup:${status.threadId ?? `unattributed:${status.runtimeId}`}:${status.serverName}`,
    label: `${status.serverName} · ${status.status}`,
    detail: status.failure
      ? status.failure.phase === 'readiness'
        ? `Backend readiness: ${status.failure.readinessReason ?? 'unknown'}.`
        : `Startup observation: ${status.failure.code}. Child exit diagnostics are unavailable.`
      : `Startup observation: ${status.status}.`,
    mcpStartup: status,
  };
}

export function startupToolLabel(server: McpStartupFailure['serverName']): string {
  return server === 'gestalt-serena'
    ? 'Serena'
    : server === 'gestalt-xerj'
      ? 'XERJ'
      : 'Context Mode';
}

export function startupFailureReason(code: McpStartupFailure['code']): string {
  return {
    'artifact-unavailable': 'A required runtime artifact was unavailable.',
    'process-exited': 'The child process exited before startup completed.',
    'protocol-rejected': 'The initialize request was rejected.',
    timeout: 'The initialize request timed out.',
    'reauthentication-required': 'Codex reported that authentication is required again.',
    'startup-failed': 'Codex reported a startup failure without a more specific reason.',
    cancelled: 'Startup was cancelled.',
    'readiness-failed': 'Gestalt could not prepare the XERJ backend.',
  }[code];
}

export function startupRecoveryGuidance(server: McpStartupFailure['serverName']): string {
  return server === 'gestalt-serena'
    ? 'Optional tool unavailable. Continue with native code tools. Operators can inspect it with gestalt serena doctor.'
    : server === 'gestalt-xerj'
      ? 'Optional retrieval unavailable. Continue with rg and current source reads. Operators can inspect gestalt xerj status.'
      : 'Required tool unavailable. The affected startup cannot continue until Context Mode is available. Operators can inspect it with ctx-doctor.';
}
