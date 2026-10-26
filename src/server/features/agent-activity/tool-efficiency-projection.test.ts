/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  ToolEfficiencyProjection,
  type ToolEfficiencyState,
} from './tool-efficiency-projection.js';
import { decodeToolEfficiencyFacts } from '../../platform/codex/tool-efficiency-facts.js';
import type { ToolEfficiencyFact } from './tool-efficiency.js';

const at = '2026-10-26T18:50:00Z';
const later = '2026-10-26T18:51:00Z';
function fact(
  item: Record<string, unknown> = {},
  options: { phase?: string; runtimeId?: string; threadId?: string; at?: string } = {},
): ToolEfficiencyFact {
  return decodeToolEfficiencyFacts(
    'session',
    options.at ?? at,
    {
      method: options.phase ?? 'item/completed',
      params: {
        threadId: options.threadId ?? 'root',
        turnId: 'turn',
        item: {
          id: 'call',
          type: 'commandExecution',
          status: 'completed',
          durationMs: 0,
          aggregatedOutput: '',
          ...item,
        },
      },
    },
    { runtimeId: options.runtimeId ?? 'runtime', rootThreadId: 'root' },
  )[0] as ToolEfficiencyFact;
}
function fixture(limits?: { calls: number; groups: number }) {
  let state: ToolEfficiencyState | null = null;
  const store = {
    load: () => state,
    save: (_id: string, next: ToolEfficiencyState) => {
      state = next;
    },
  };
  return { projection: new ToolEfficiencyProjection(store, limits), store };
}

describe('tool efficiency aggregation', () => {
  it('replaces starts with completions and ignores duplicates and late starts', () => {
    const { projection } = fixture();
    projection.observe(fact({}, { phase: 'item/started' }));
    expect(projection.snapshot('session').groups[0]).toMatchObject({
      calls: 1,
      completedCalls: 0,
      durationMs: { value: null, measuredCalls: 0, coverage: 'unknown' },
    });
    const completed = fact({ durationMs: 30, aggregatedOutput: 'abc' });
    projection.observe(completed);
    const snapshot = projection.snapshot('session');
    expect(snapshot.groups[0]).toMatchObject({
      calls: 1,
      completedCalls: 1,
      durationMs: { value: 30, measuredCalls: 1, coverage: 'complete' },
      deliveredBytes: { value: 3 },
    });
    expect(projection.observe({ ...completed, occurredAt: later })).toBeNull();
    expect(projection.observe(fact({}, { phase: 'item/started', at: later }))).toBeNull();
    expect(projection.snapshot('session')).toEqual(snapshot);
  });

  it('accepts completion before start, and ignores older competing completion facts', () => {
    const { projection } = fixture();
    projection.observe(fact({ durationMs: 40 }, { at: later }));
    projection.observe(fact({ durationMs: 5 }));
    projection.observe(fact({}, { phase: 'item/started' }));
    expect(projection.snapshot('session').groups[0]).toMatchObject({
      calls: 1,
      durationMs: { value: 40 },
    });
  });

  it('retains known measurements when a later replay omits counters', () => {
    const { projection } = fixture();
    projection.observe(fact({ durationMs: 40, aggregatedOutput: 'known' }));
    expect(
      projection.observe(fact({ durationMs: null, aggregatedOutput: null }, { at: later })),
    ).toBeNull();
    expect(projection.snapshot('session').groups[0]).toMatchObject({
      calls: 1,
      durationMs: { value: 40 },
      deliveredBytes: { value: 5 },
    });
  });

  it('does not report an unsafe integer sum as a measured complete total', () => {
    const { projection } = fixture();
    projection.observe(fact({ durationMs: Number.MAX_SAFE_INTEGER }));
    projection.observe(fact({ id: 'other', durationMs: 1 }));
    expect(projection.snapshot('session').groups[0].durationMs).toEqual({
      value: null,
      measuredCalls: 2,
      coverage: 'partial',
    });
  });

  it('separates nested wrappers, root/child tools, resumed child turns and runtime generations', () => {
    const { projection } = fixture();
    projection.observe(
      fact({
        type: 'dynamicToolCall',
        namespace: 'functions',
        tool: 'exec',
        contentItems: [],
        arguments: {
          code: 'await tools.exec_command({cmd: "secret"});\nawait tools.exec_command({cmd:"second"})',
        },
      }),
    );
    projection.observe(fact({ id: 'nested', durationMs: 7 }, { threadId: 'child' }));
    projection.observe({
      ...fact({ id: 'resumed', durationMs: 3 }, { threadId: 'child' }),
      identity: { ...fact().identity, threadId: 'child', actor: 'child', turnId: 'resumed-turn' },
    });
    projection.observe(
      fact({ id: 'nested', durationMs: 9 }, { threadId: 'child', runtimeId: 'runtime-2' }),
    );
    const snapshot = projection.snapshot('session');
    expect(snapshot.groups).toHaveLength(3);
    expect(snapshot.groups.find((group) => group.layer === 'wrapper')).toMatchObject({
      calls: 1,
      actor: 'root',
      family: 'executionWrapper',
    });
    expect(
      snapshot.groups.find((group) => group.runtimeId === 'runtime' && group.actor === 'child'),
    ).toMatchObject({ calls: 2, durationMs: { value: 10 } });
    expect(snapshot.groups.find((group) => group.runtimeId === 'runtime-2')).toMatchObject({
      calls: 1,
      durationMs: { value: 9 },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|exec_command|second/);
  });

  it('preserves measured zero, failed call costs and mixed unknown metric coverage', () => {
    const { projection } = fixture();
    projection.observe(fact({ durationMs: 0, status: 'failed', exitCode: 1 }));
    projection.observe(fact({ id: 'old', durationMs: null, aggregatedOutput: null }));
    expect(projection.snapshot('session')).toMatchObject({
      coverage: 'partial',
      scope: 'observedCallsOnly',
      groups: [
        {
          calls: 2,
          completedCalls: 2,
          failedCalls: 1,
          durationMs: { value: 0, measuredCalls: 1, coverage: 'partial' },
          deliveredBytes: { value: 0, measuredCalls: 1, coverage: 'partial' },
          retries: { value: null, coverage: 'unknown' },
          reusedCalls: { value: null },
          completeness: { capture: { complete: 0, partial: 0, unknown: 0, missing: 2 } },
        },
      ],
    });
  });

  it('excludes uncorrelated observations without inventing a call count and keeps that gap durable', () => {
    const { projection, store } = fixture();
    const unknown = {
      ...fact(),
      eventKey: null,
      identity: { ...fact().identity, runtimeId: null, actor: 'unknown' as const },
    };
    projection.observe(unknown);
    expect(projection.observe(unknown)).toBeNull();
    projection.observe(fact());
    expect(new ToolEfficiencyProjection(store).snapshot('session')).toMatchObject({
      missingCorrelation: true,
      coverage: 'partial',
      groups: [{ calls: 1 }],
    });
  });

  it('excludes a physical thread whose session ownership is unknown', () => {
    const { projection } = fixture();
    const unrelated = fact({}, { threadId: 'unrelated' });
    projection.observe({ ...unrelated, identity: { ...unrelated.identity, actor: 'unknown' } });
    expect(projection.snapshot('session')).toMatchObject({ missingCorrelation: true, groups: [] });
  });

  it('does not aggregate provider snapshots as tool cost', () => {
    const { projection } = fixture();
    for (let n = 0; n < 2; n++)
      for (const usage of decodeToolEfficiencyFacts('session', at, {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'root',
          tokenUsage: { last: { totalTokens: 100 }, total: { totalTokens: 1000 } },
        },
      }))
        expect(projection.observe(usage)).toBeNull();
    expect(projection.snapshot('session')).toMatchObject({
      coverage: 'unknown',
      observedAt: null,
      groups: [],
    });
  });

  it('aggregates explicit completeness separately from missing metadata', () => {
    const { projection } = fixture();
    projection.observe(
      fact({
        type: 'mcpToolCall',
        server: 'context-mode',
        tool: 'ctx_execute',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                provenance: { operationId: 'operation' },
                overflow: {},
                captureCompleteness: 'complete',
                displayCompleteness: 'partial',
                evidenceCompleteness: 'unknown',
              }),
            },
          ],
        },
      }),
    );
    projection.observe(
      fact({
        id: 'old',
        type: 'mcpToolCall',
        server: 'context-mode',
        tool: 'ctx_execute',
        result: { content: [] },
      }),
    );
    expect(projection.snapshot('session').groups[0]).toMatchObject({
      calls: 2,
      truncatedCalls: { value: 1, measuredCalls: 1, coverage: 'partial' },
      completeness: {
        capture: { complete: 1, partial: 0, unknown: 0, missing: 1 },
        display: { complete: 0, partial: 1, unknown: 0, missing: 1 },
        evidence: { complete: 0, partial: 0, unknown: 1, missing: 1 },
      },
    });
  });

  it('bounds retained calls/groups and preserves existing dedup keys and later completions', () => {
    const { projection, store } = fixture({ calls: 2, groups: 1 });
    projection.observe(fact({}, { phase: 'item/started' }));
    projection.observe(fact({ id: 'other' }));
    projection.observe(fact({ id: 'third' }));
    projection.observe(fact({ id: 'child' }, { threadId: 'child' }));
    projection.observe(fact({ durationMs: 5 }));
    const snapshot = new ToolEfficiencyProjection(store).snapshot('session');
    expect(snapshot).toMatchObject({
      retentionLimited: true,
      coverage: 'partial',
      groups: [{ calls: 2, completedCalls: 2, durationMs: { value: 5 } }],
    });
    expect(projection.observe(fact({ id: 'third' }))).toBeNull();
  });
});
