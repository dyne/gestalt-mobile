/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Unknown is null, never an estimated zero. Sources name protocol fields, not content. */
export type EfficiencyMeasurement<T, U extends string> = Readonly<{
  value: T | null;
  unit: U;
  source: string | null;
}>;
export type EfficiencyIdentity = Readonly<{
  sessionId: string;
  runtimeId: string | null;
  threadId: string | null;
  turnId: string | null;
  actor: 'root' | 'child' | 'unknown';
}>;
export type ToolEfficiencyFact = Readonly<{
  kind: 'tool';
  identity: EfficiencyIdentity;
  occurredAt: string;
  /** Null without runtime and thread correlation; never deduplicate uncorrelated calls together. */
  eventKey: string | null;
  itemId: string;
  phase: 'started' | 'completed';
  family: 'command' | 'mcp' | 'contextMode' | 'executionWrapper' | 'dynamic' | 'collaboration';
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  scope: 'toolCall';
  duration: EfficiencyMeasurement<number, 'milliseconds'>;
  retries: EfficiencyMeasurement<number, 'retries'>;
  reuse: EfficiencyMeasurement<boolean, 'boolean'>;
  bytes: Readonly<{
    raw: EfficiencyMeasurement<number, 'bytes'>;
    processed: EfficiencyMeasurement<number, 'bytes'>;
    /** Bytes in the app-server result, not necessarily the model's eventual input. */
    delivered: EfficiencyMeasurement<number, 'bytes'>;
    deliveredScope:
      'commandOutputUtf8' | 'serializedMcpContent' | 'serializedDynamicContent' | null;
  }>;
  truncated: EfficiencyMeasurement<boolean, 'boolean'>;
  completeness: Readonly<{
    capture: EfficiencyMeasurement<'complete' | 'partial' | 'unknown', 'completeness'>;
    display: EfficiencyMeasurement<'complete' | 'partial' | 'unknown', 'completeness'>;
    evidence: EfficiencyMeasurement<'complete' | 'partial' | 'unknown', 'completeness'>;
  }>;
  /** Coverage of supported cost/quality fields, not session coverage or evidence correctness. */
  coverage: 'partial' | 'unknown';
}>;

export const providerTokenFields = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const;
export type ProviderUsageFact = Readonly<{
  kind: 'providerUsage';
  identity: EfficiencyIdentity;
  occurredAt: string;
  /** Provider snapshots are authoritative thread usage, never attributed to a tool. */
  scope: 'threadUsageSnapshot';
  last: Readonly<
    Record<(typeof providerTokenFields)[number], EfficiencyMeasurement<number, 'tokens'>>
  >;
  total: Readonly<
    Record<(typeof providerTokenFields)[number], EfficiencyMeasurement<number, 'tokens'>>
  >;
}>;
export type ToolEfficiencyObservation = ToolEfficiencyFact | ProviderUsageFact;
