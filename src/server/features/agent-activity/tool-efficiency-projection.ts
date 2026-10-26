/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ToolEfficiencyFact, ToolEfficiencyObservation } from './tool-efficiency.js';
import type { EfficiencyMeasurement } from './tool-efficiency.js';
import type {
  EfficiencyTotal,
  ToolEfficiencyGroup,
  ToolEfficiencySnapshot,
} from '../../../shared/contracts/tool-efficiency.js';

export type ToolEfficiencyState = Readonly<{
  revision?: number;
  calls: readonly ToolEfficiencyFact[];
  observedAt: string | null;
  missingCorrelation: boolean;
  retentionLimited: boolean;
}>;
export interface ToolEfficiencyStore {
  load(sessionId: string): ToolEfficiencyState | null;
  save(sessionId: string, state: ToolEfficiencyState): void;
}
const empty = (): ToolEfficiencyState => ({
  calls: [],
  observedAt: null,
  missingCorrelation: false,
  retentionLimited: false,
});
const callKey = (fact: ToolEfficiencyFact) =>
  JSON.stringify([fact.identity.runtimeId, fact.identity.threadId, fact.itemId]);
const groupKey = (fact: ToolEfficiencyFact) =>
  JSON.stringify([
    fact.identity.runtimeId,
    fact.identity.threadId,
    fact.identity.actor,
    fact.family,
  ]);
const semantic = (fact: ToolEfficiencyFact) => JSON.stringify({ ...fact, occurredAt: undefined });
const retainKnown = <T, U extends string>(
  before: EfficiencyMeasurement<T, U>,
  next: EfficiencyMeasurement<T, U>,
) => (next.value === null ? before : next);

function mergeCall(before: ToolEfficiencyFact, next: ToolEfficiencyFact): ToolEfficiencyFact {
  return {
    ...next,
    duration: retainKnown(before.duration, next.duration),
    retries: retainKnown(before.retries, next.retries),
    reuse: retainKnown(before.reuse, next.reuse),
    truncated: retainKnown(before.truncated, next.truncated),
    bytes: {
      raw: retainKnown(before.bytes.raw, next.bytes.raw),
      processed: retainKnown(before.bytes.processed, next.bytes.processed),
      delivered: retainKnown(before.bytes.delivered, next.bytes.delivered),
      deliveredScope:
        next.bytes.delivered.value === null
          ? before.bytes.deliveredScope
          : next.bytes.deliveredScope,
    },
    completeness: {
      capture: retainKnown(before.completeness.capture, next.completeness.capture),
      display: retainKnown(before.completeness.display, next.completeness.display),
      evidence: retainKnown(before.completeness.evidence, next.completeness.evidence),
    },
    coverage: before.coverage === 'partial' || next.coverage === 'partial' ? 'partial' : 'unknown',
  };
}

/** Bounded content-free projection. Persistence is a port; no provider usage enters tool totals. */
export class ToolEfficiencyProjection {
  constructor(
    private readonly store: ToolEfficiencyStore,
    private readonly limits = { calls: 1024, groups: 64 },
  ) {}

  observe(observation: ToolEfficiencyObservation): ToolEfficiencySnapshot | null {
    if (observation.kind !== 'tool') return null;
    const { sessionId, runtimeId, threadId } = observation.identity;
    const current = this.store.load(sessionId) ?? empty();
    let next: ToolEfficiencyState;
    if (
      !runtimeId ||
      !threadId ||
      !observation.eventKey ||
      observation.identity.actor === 'unknown'
    ) {
      if (current.missingCorrelation) return null;
      next = {
        ...current,
        missingCorrelation: true,
        observedAt:
          !current.observedAt || Date.parse(observation.occurredAt) > Date.parse(current.observedAt)
            ? observation.occurredAt
            : current.observedAt,
      };
    } else {
      const index = current.calls.findIndex((fact) => callKey(fact) === callKey(observation));
      const before = current.calls[index];
      if (before) {
        if (before.phase === 'completed' && observation.phase === 'started') return null;
        if (
          before.phase === observation.phase &&
          Date.parse(before.occurredAt) > Date.parse(observation.occurredAt)
        )
          return null;
        const merged = mergeCall(before, observation);
        if (semantic(before) === semantic(merged)) return null;
        const calls = [...current.calls];
        calls[index] = merged;
        next = { ...current, calls };
      } else {
        const groups = new Set(current.calls.map(groupKey));
        if (
          current.calls.length >= this.limits.calls ||
          (!groups.has(groupKey(observation)) && groups.size >= this.limits.groups)
        ) {
          if (current.retentionLimited) return null;
          next = { ...current, retentionLimited: true };
        } else next = { ...current, calls: [...current.calls, observation] };
      }
      next = {
        ...next,
        observedAt:
          !current.observedAt || Date.parse(observation.occurredAt) > Date.parse(current.observedAt)
            ? observation.occurredAt
            : current.observedAt,
      };
    }
    next = { ...next, revision: (current.revision ?? 0) + 1 };
    this.store.save(sessionId, next);
    return summarizeToolEfficiency(sessionId, next);
  }

  snapshot(sessionId: string): ToolEfficiencySnapshot {
    return summarizeToolEfficiency(sessionId, this.store.load(sessionId) ?? empty());
  }
}

export function summarizeToolEfficiency(
  sessionId: string,
  state: ToolEfficiencyState,
): ToolEfficiencySnapshot {
  const groups = new Map<string, ToolEfficiencyFact[]>();
  for (const fact of state.calls) {
    const key = groupKey(fact);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  return {
    sessionId,
    revision: state.revision ?? 0,
    observedAt: state.observedAt,
    scope: 'observedCallsOnly',
    coverage:
      state.calls.length || state.missingCorrelation || state.retentionLimited
        ? 'partial'
        : 'unknown',
    missingCorrelation: state.missingCorrelation,
    retentionLimited: state.retentionLimited,
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, calls]) => summarizeGroup(calls)),
  };
}

function summarizeGroup(calls: readonly ToolEfficiencyFact[]): ToolEfficiencyGroup {
  const first = calls[0];
  const total = (read: (fact: ToolEfficiencyFact) => number | boolean | null): EfficiencyTotal => {
    const known = calls.map(read).filter((value) => value !== null);
    const sum = known.reduce<number>((value, next) => value + Number(next), 0);
    return {
      value: known.length && Number.isSafeInteger(sum) ? sum : null,
      measuredCalls: known.length,
      coverage: !known.length
        ? 'unknown'
        : known.length === calls.length && Number.isSafeInteger(sum)
          ? 'complete'
          : 'partial',
    };
  };
  const completeness = (scope: 'capture' | 'display' | 'evidence') => {
    const result = { complete: 0, partial: 0, unknown: 0, missing: 0 };
    for (const fact of calls) result[fact.completeness[scope].value ?? 'missing']++;
    return result;
  };
  return {
    runtimeId: first.identity.runtimeId!,
    threadId: first.identity.threadId!,
    actor: first.identity.actor,
    family: first.family,
    layer: first.family === 'executionWrapper' ? 'wrapper' : 'tool',
    calls: calls.length,
    completedCalls: calls.filter((fact) => fact.phase === 'completed').length,
    failedCalls: calls.filter((fact) => fact.status === 'failed').length,
    durationMs: total((fact) => fact.duration.value),
    deliveredBytes: total((fact) => fact.bytes.delivered.value),
    deliveredScope:
      calls.find((fact) => fact.bytes.deliveredScope !== null)?.bytes.deliveredScope ?? null,
    rawBytes: total((fact) => fact.bytes.raw.value),
    processedBytes: total((fact) => fact.bytes.processed.value),
    retries: total((fact) => fact.retries.value),
    reusedCalls: total((fact) => fact.reuse.value),
    truncatedCalls: total((fact) => fact.truncated.value),
    completeness: {
      capture: completeness('capture'),
      display: completeness('display'),
      evidence: completeness('evidence'),
    },
  };
}
