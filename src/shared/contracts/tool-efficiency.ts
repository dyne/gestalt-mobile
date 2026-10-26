/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type EfficiencyTotal = Readonly<{
  value: number | null;
  measuredCalls: number;
  coverage: 'complete' | 'partial' | 'unknown';
}>;
export type ToolEfficiencyGroup = Readonly<{
  runtimeId: string;
  threadId: string;
  actor: 'root' | 'child' | 'unknown';
  family: 'command' | 'mcp' | 'contextMode' | 'executionWrapper' | 'dynamic' | 'collaboration';
  layer: 'wrapper' | 'tool';
  calls: number;
  completedCalls: number;
  failedCalls: number;
  durationMs: EfficiencyTotal;
  deliveredBytes: EfficiencyTotal;
  deliveredScope: 'commandOutputUtf8' | 'serializedMcpContent' | 'serializedDynamicContent' | null;
  rawBytes: EfficiencyTotal;
  processedBytes: EfficiencyTotal;
  retries: EfficiencyTotal;
  reusedCalls: EfficiencyTotal;
  truncatedCalls: EfficiencyTotal;
  completeness: Readonly<
    Record<
      'capture' | 'display' | 'evidence',
      Readonly<{
        complete: number;
        partial: number;
        unknown: number;
        missing: number;
      }>
    >
  >;
}>;
export type ToolEfficiencySnapshot = Readonly<{
  sessionId: string;
  revision: number;
  observedAt: string | null;
  /** Never a claim about the entire session or provider cost. */
  scope: 'observedCallsOnly';
  coverage: 'partial' | 'unknown';
  missingCorrelation: boolean;
  retentionLimited: boolean;
  groups: readonly ToolEfficiencyGroup[];
}>;

/** Whitelist the bounded public DTO; unknown fields and private metadata are discarded. */
export function parseToolEfficiencySnapshot(
  input: unknown,
  sessionId: string,
): ToolEfficiencySnapshot | null {
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const id = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
  const value = object(input);
  if (
    !value ||
    !id(value.sessionId) ||
    value.sessionId !== sessionId ||
    !count(value.revision) ||
    value.scope !== 'observedCallsOnly' ||
    !['partial', 'unknown'].includes(String(value.coverage)) ||
    typeof value.missingCorrelation !== 'boolean' ||
    typeof value.retentionLimited !== 'boolean' ||
    !Array.isArray(value.groups) ||
    value.groups.length > 64 ||
    !(
      value.observedAt === null ||
      (typeof value.observedAt === 'string' &&
        value.observedAt.length <= 64 &&
        Number.isFinite(Date.parse(value.observedAt)))
    )
  )
    return null;
  const groups: ToolEfficiencyGroup[] = [];
  const identities = new Set<string>();
  for (const raw of value.groups) {
    const group = object(raw);
    if (
      !group ||
      !id(group.runtimeId) ||
      !id(group.threadId) ||
      !['root', 'child', 'unknown'].includes(String(group.actor)) ||
      !['command', 'mcp', 'contextMode', 'executionWrapper', 'dynamic', 'collaboration'].includes(
        String(group.family),
      ) ||
      group.layer !== (group.family === 'executionWrapper' ? 'wrapper' : 'tool') ||
      !count(group.calls) ||
      group.calls < 1 ||
      group.calls > 1024 ||
      !count(group.completedCalls) ||
      group.completedCalls > group.calls ||
      !count(group.failedCalls) ||
      group.failedCalls > group.calls ||
      !(
        group.deliveredScope === null ||
        (typeof group.deliveredScope === 'string' &&
          ['commandOutputUtf8', 'serializedMcpContent', 'serializedDynamicContent'].includes(
            group.deliveredScope,
          ))
      )
    )
      return null;
    const identity = JSON.stringify([group.runtimeId, group.threadId, group.actor, group.family]);
    if (identities.has(identity)) return null;
    identities.add(identity);
    const metrics: Partial<
      Record<
        | 'durationMs'
        | 'deliveredBytes'
        | 'rawBytes'
        | 'processedBytes'
        | 'retries'
        | 'reusedCalls'
        | 'truncatedCalls',
        EfficiencyTotal
      >
    > = {};
    for (const key of [
      'durationMs',
      'deliveredBytes',
      'rawBytes',
      'processedBytes',
      'retries',
      'reusedCalls',
      'truncatedCalls',
    ] as const) {
      const metric = object(group[key]);
      if (
        !metric ||
        !(metric.value === null || count(metric.value)) ||
        !count(metric.measuredCalls) ||
        metric.measuredCalls > group.calls ||
        (metric.value !== null && metric.measuredCalls === 0) ||
        !['complete', 'partial', 'unknown'].includes(String(metric.coverage)) ||
        (metric.coverage === 'complete' &&
          (metric.value === null || metric.measuredCalls !== group.calls)) ||
        (metric.coverage === 'unknown' && (metric.value !== null || metric.measuredCalls !== 0))
      )
        return null;
      metrics[key] = {
        value: metric.value as number | null,
        measuredCalls: metric.measuredCalls,
        coverage: metric.coverage as EfficiencyTotal['coverage'],
      };
    }
    const quality = object(group.completeness);
    const counts = {} as Record<
      'capture' | 'display' | 'evidence',
      { complete: number; partial: number; unknown: number; missing: number }
    >;
    for (const key of ['capture', 'display', 'evidence'] as const) {
      const entry = object(quality?.[key]);
      if (
        !entry ||
        !count(entry.complete) ||
        !count(entry.partial) ||
        !count(entry.unknown) ||
        !count(entry.missing) ||
        entry.complete + entry.partial + entry.unknown + entry.missing !== group.calls
      )
        return null;
      counts[key] = {
        complete: entry.complete,
        partial: entry.partial,
        unknown: entry.unknown,
        missing: entry.missing,
      };
    }
    groups.push({
      runtimeId: group.runtimeId,
      threadId: group.threadId,
      actor: group.actor as ToolEfficiencyGroup['actor'],
      family: group.family as ToolEfficiencyGroup['family'],
      layer: group.layer as ToolEfficiencyGroup['layer'],
      calls: group.calls,
      completedCalls: group.completedCalls,
      failedCalls: group.failedCalls,
      ...(metrics as Required<typeof metrics>),
      deliveredScope: group.deliveredScope as ToolEfficiencyGroup['deliveredScope'],
      completeness: counts,
    });
  }
  if (groups.reduce((sum, group) => sum + group.calls, 0) > 1024) return null;
  return {
    sessionId,
    revision: value.revision,
    observedAt: value.observedAt as string | null,
    scope: 'observedCallsOnly',
    coverage: value.coverage as ToolEfficiencySnapshot['coverage'],
    missingCorrelation: value.missingCorrelation,
    retentionLimited: value.retentionLimited,
    groups,
  };
}
