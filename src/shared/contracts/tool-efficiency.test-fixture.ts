/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { EfficiencyTotal, ToolEfficiencySnapshot } from './tool-efficiency.js';

/** Small synthetic metadata shared by component, controller and browser contract tests. */
export function efficiencyFixture(sessionId = 'session', revision = 1): ToolEfficiencySnapshot {
  const unknown: EfficiencyTotal = { value: null, measuredCalls: 0, coverage: 'unknown' };
  const known = (value: number, partial = false): EfficiencyTotal => ({
    value,
    measuredCalls: 1,
    coverage: partial ? 'partial' : 'complete',
  });
  const missing = (calls: number) => ({ complete: 0, partial: 0, unknown: 0, missing: calls });
  const base = {
    runtimeId: 'runtime-one',
    calls: 1,
    completedCalls: 1,
    failedCalls: 0,
    rawBytes: unknown,
    processedBytes: unknown,
    retries: unknown,
    reusedCalls: unknown,
    truncatedCalls: unknown,
    completeness: { capture: missing(1), display: missing(1), evidence: missing(1) },
  };
  return {
    sessionId,
    revision,
    observedAt: '2026-10-26T19:00:00Z',
    scope: 'observedCallsOnly',
    coverage: 'partial',
    missingCorrelation: true,
    retentionLimited: true,
    groups: [
      {
        ...base,
        threadId: 'root',
        actor: 'root',
        family: 'command',
        layer: 'tool',
        durationMs: known(0),
        deliveredBytes: known(0),
        deliveredScope: 'commandOutputUtf8',
      },
      {
        ...base,
        threadId: 'root',
        actor: 'root',
        family: 'executionWrapper',
        layer: 'wrapper',
        durationMs: known(8),
        deliveredBytes: known(512),
        deliveredScope: 'serializedDynamicContent',
      },
      {
        ...base,
        threadId: 'child-thread-with-a-long-opaque-identity',
        actor: 'child',
        family: 'contextMode',
        layer: 'tool',
        calls: 2,
        completedCalls: 2,
        failedCalls: 1,
        durationMs: known(240, true),
        deliveredBytes: known(4096, true),
        deliveredScope: 'serializedMcpContent',
        truncatedCalls: known(1, true),
        completeness: {
          capture: { complete: 1, partial: 0, unknown: 0, missing: 1 },
          display: { complete: 0, partial: 1, unknown: 0, missing: 1 },
          evidence: { complete: 0, partial: 0, unknown: 1, missing: 1 },
        },
      },
    ],
  };
}
