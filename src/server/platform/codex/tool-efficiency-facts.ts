/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  providerTokenFields,
  type EfficiencyMeasurement,
  type ToolEfficiencyFact,
  type ToolEfficiencyObservation,
  type ProviderUsageFact,
} from '../../features/agent-activity/tool-efficiency.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value) ? value : null;
const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const measure = <T, U extends string>(
  value: T | null,
  unit: U,
  source: string,
): EfficiencyMeasurement<T, U> => ({ value, unit, source: value === null ? null : source });
const completeness = (
  value: unknown,
  source: string,
): ToolEfficiencyFact['completeness']['capture'] =>
  measure(
    value === 'complete' || value === 'partial' || value === 'unknown' ? value : null,
    'completeness',
    source,
  );

/** Pure, bounded metadata projection. It never parses executable bodies or retains results. */
export function decodeToolEfficiencyFacts(
  sessionId: string,
  occurredAt: string,
  input: { method?: string; params?: unknown },
  correlation: {
    runtimeId?: string;
    rootThreadId?: string;
    physicalThreadId?: string;
    physicalTurnId?: string;
    actor?: 'root' | 'child' | 'unknown';
  } = {},
): readonly ToolEfficiencyObservation[] {
  const params = record(input.params);
  if (!params || !Number.isFinite(Date.parse(occurredAt))) return [];
  const threadId = id(correlation.physicalThreadId) ?? id(params.threadId);
  const runtimeId = id(correlation.runtimeId);
  const rootThreadId = id(correlation.rootThreadId);
  const identity = {
    sessionId,
    runtimeId,
    threadId,
    turnId: id(correlation.physicalTurnId) ?? id(params.turnId),
    actor:
      correlation.actor ??
      (threadId && rootThreadId
        ? threadId === rootThreadId
          ? ('root' as const)
          : ('child' as const)
        : ('unknown' as const)),
  };
  if (input.method === 'thread/tokenUsage/updated') {
    if (!threadId) return [];
    const usage = record(params.tokenUsage);
    const tokens = (scope: 'last' | 'total'): ProviderUsageFact['last'] =>
      Object.fromEntries(
        providerTokenFields.map((field) => [
          field,
          measure(
            counter(record(usage?.[scope])?.[field]),
            'tokens',
            `tokenUsage.${scope}.${field}`,
          ),
        ]),
      ) as ProviderUsageFact['last'];
    const last = tokens('last');
    const total = tokens('total');
    if (![...Object.values(last), ...Object.values(total)].some((metric) => metric.value !== null))
      return [];
    return [
      { kind: 'providerUsage', identity, occurredAt, scope: 'threadUsageSnapshot', last, total },
    ];
  }
  if (input.method !== 'item/started' && input.method !== 'item/completed') return [];
  const item = record(params.item);
  const itemId = id(item?.id);
  const family = toolFamily(item);
  if (!item || !itemId || !family) return [];
  const phase = input.method === 'item/started' ? 'started' : 'completed';
  const result = record(item.result);
  let delivered: number | null = null;
  let deliveredScope: ToolEfficiencyFact['bytes']['deliveredScope'] = null;
  let deliveredSource = '';
  if (phase === 'completed') {
    if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
      delivered = Buffer.byteLength(item.aggregatedOutput, 'utf8');
      deliveredScope = 'commandOutputUtf8';
      deliveredSource = 'item.aggregatedOutput';
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      const content = item.type === 'mcpToolCall' ? result?.content : item.contentItems;
      if (Array.isArray(content)) {
        // This is the serialized visible content only; arguments, _meta and duplicate
        // structuredContent are excluded. It is not a raw-output or token measurement.
        try {
          delivered = Buffer.byteLength(JSON.stringify(content), 'utf8');
          deliveredScope =
            item.type === 'mcpToolCall' ? 'serializedMcpContent' : 'serializedDynamicContent';
          deliveredSource =
            item.type === 'mcpToolCall' ? 'item.result.content' : 'item.contentItems';
        } catch {
          /* Non-JSON input has unknown byte coverage. */
        }
      }
    }
  }
  const quality =
    phase === 'completed' && family === 'contextMode' ? contextModeQuality(result) : undefined;
  const duration = measure(
    phase === 'completed' &&
      (item.type === 'commandExecution' ||
        item.type === 'mcpToolCall' ||
        item.type === 'dynamicToolCall')
      ? counter(item.durationMs)
      : null,
    'milliseconds',
    'item.durationMs',
  );
  const capture = completeness(quality?.captureCompleteness, 'contextMode.captureCompleteness');
  const display = completeness(quality?.displayCompleteness, 'contextMode.displayCompleteness');
  const evidence = completeness(quality?.evidenceCompleteness, 'contextMode.evidenceCompleteness');
  return [
    {
      kind: 'tool',
      identity,
      occurredAt,
      itemId,
      phase,
      family,
      scope: 'toolCall',
      eventKey:
        runtimeId && threadId
          ? JSON.stringify([sessionId, runtimeId, threadId, itemId, phase])
          : null,
      status:
        item.status === 'failed' ||
        (item.type === 'dynamicToolCall' && item.success === false) ||
        (item.type === 'commandExecution' &&
          typeof item.exitCode === 'number' &&
          Number.isSafeInteger(item.exitCode) &&
          item.exitCode !== 0)
          ? 'failed'
          : phase === 'started' || item.status === 'inProgress'
            ? 'running'
            : item.status === 'completed'
              ? 'succeeded'
              : 'unknown',
      duration,
      retries: measure(null, 'retries', ''),
      reuse: measure(null, 'boolean', ''),
      bytes: {
        raw: measure(null, 'bytes', ''),
        processed: measure(null, 'bytes', ''),
        delivered: measure(delivered, 'bytes', deliveredSource),
        deliveredScope,
      },
      // Partial display is explicit truncation; absence of this flag is not proof of no truncation.
      truncated: measure(
        display.value === 'partial' ? true : null,
        'boolean',
        'contextMode.displayCompleteness',
      ),
      completeness: { capture, display, evidence },
      coverage:
        delivered !== null ||
        duration.value !== null ||
        [capture, display, evidence].some((metric) => metric.value !== null)
          ? 'partial'
          : 'unknown',
    },
  ];
}

function toolFamily(
  item: Record<string, unknown> | undefined,
): ToolEfficiencyFact['family'] | null {
  if (item?.type === 'commandExecution') return 'command';
  if (item?.type === 'collabAgentToolCall' || item?.type === 'collabToolCall')
    return 'collaboration';
  if (item?.type === 'mcpToolCall') {
    return item.server === 'context-mode' &&
      typeof item.tool === 'string' &&
      /^ctx_[a-z_]+$/.test(item.tool)
      ? 'contextMode'
      : 'mcp';
  }
  if (item?.type === 'dynamicToolCall')
    return item.namespace === 'functions' && item.tool === 'exec' ? 'executionWrapper' : 'dynamic';
  return null;
}

/** Only the first documented context-mode metadata block is read; previews/nested output are opaque. */
function contextModeQuality(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(result?.content)) return undefined;
  const first = record(result.content[0]);
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  const line = first.text.slice(0, 16_385).split('\n', 1)[0];
  if (line.length > 16_384) return undefined;
  try {
    const value = record(JSON.parse(line.startsWith('Execution: ') ? line.slice(11) : line));
    // Documented execution provenance or response-budget envelope, never arbitrary tool text.
    return id(value?.operationId) ||
      id(record(value?.provenance)?.operationId) ||
      record(value?.overflow)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
