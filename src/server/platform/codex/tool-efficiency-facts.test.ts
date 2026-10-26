/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { decodeToolEfficiencyFacts } from './activity-facts.js';
import type { ToolEfficiencyFact } from '../../features/agent-activity/tool-efficiency.js';

const at = '2026-10-26T18:40:00.000Z';
const correlation = { runtimeId: 'runtime-1', rootThreadId: 'root' };
function tool(item: Record<string, unknown>, method = 'item/completed'): ToolEfficiencyFact {
  return decodeToolEfficiencyFacts(
    'session',
    at,
    {
      method,
      params: {
        threadId: 'root',
        turnId: 'turn',
        item: { id: 'call', type: 'commandExecution', ...item },
      },
    },
    correlation,
  )[0] as ToolEfficiencyFact;
}
function contextMode(header: unknown, rest = ''): ToolEfficiencyFact {
  return tool({
    type: 'mcpToolCall',
    server: 'context-mode',
    tool: 'ctx_execute',
    status: 'completed',
    result: {
      content: [{ type: 'text', text: `Execution: ${JSON.stringify(header)}\n\n${rest}` }],
    },
  });
}

describe('content-free tool efficiency observations', () => {
  it('preserves measured zero duration and empty command output without inventing other counters', () => {
    const fact = tool({
      status: 'completed',
      durationMs: 0,
      aggregatedOutput: '',
      retries: 0,
      reused: false,
    });
    expect(fact).toMatchObject({
      kind: 'tool',
      phase: 'completed',
      family: 'command',
      status: 'succeeded',
      identity: {
        sessionId: 'session',
        runtimeId: 'runtime-1',
        threadId: 'root',
        turnId: 'turn',
        actor: 'root',
      },
      duration: { value: 0, unit: 'milliseconds', source: 'item.durationMs' },
      bytes: {
        raw: { value: null },
        processed: { value: null },
        delivered: { value: 0, unit: 'bytes', source: 'item.aggregatedOutput' },
        deliveredScope: 'commandOutputUtf8',
      },
      retries: { value: null },
      reuse: { value: null },
      truncated: { value: null },
      coverage: 'partial',
    });
  });

  it('keeps partial/old events unknown rather than measured zero', () => {
    const fact = tool({ status: 'completed', aggregatedOutput: null, durationMs: null });
    expect(fact.coverage).toBe('unknown');
    expect(fact.duration).toEqual({ value: null, unit: 'milliseconds', source: null });
    expect(fact.bytes.delivered.value).toBeNull();
    expect(fact.completeness.capture.value).toBeNull();
    expect(tool({ durationMs: 2, aggregatedOutput: 'partial' }, 'item/started')).toMatchObject({
      status: 'running',
      duration: { value: null },
      bytes: { delivered: { value: null } },
      coverage: 'unknown',
    });
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '12'])(
    'rejects invalid duration %s',
    (value) => {
      expect(tool({ durationMs: value }).duration.value).toBeNull();
    },
  );

  it('measures failed calls and multibyte multiline output without examining command intent', () => {
    const fact = tool({
      status: 'completed',
      exitCode: 2,
      durationMs: 42,
      command: 'grep secret\nexec nested()',
      aggregatedOutput: 'é\n🐈',
    });
    expect(fact.status).toBe('failed');
    expect(fact.bytes.delivered.value).toBe(7);
    expect(JSON.stringify(fact)).not.toMatch(/grep|secret|nested|🐈/);
    expect(
      tool({ type: 'mcpToolCall', status: 'failed', error: { message: 'private' } }),
    ).toMatchObject({ status: 'failed', bytes: { delivered: { value: null } } });
  });

  it('counts serialized MCP content separately from raw output, structured duplicates and metadata', () => {
    const content = [{ type: 'text', text: 'hello' }];
    const fact = tool({
      type: 'mcpToolCall',
      result: { content, structuredContent: { output: 'duplicate' }, _meta: { secret: 'private' } },
    });
    expect(fact.bytes.delivered.value).toBe(Buffer.byteLength(JSON.stringify(content)));
    expect(fact.bytes.deliveredScope).toBe('serializedMcpContent');
    expect(tool({ type: 'mcpToolCall', result: { content: [] } }).bytes.delivered.value).toBe(2);
    expect(JSON.stringify(fact)).not.toMatch(/hello|duplicate|private/);
  });

  it('leaves failed dynamic results unknown when missing and treats an exec as one wrapper', () => {
    const fact = tool({
      type: 'dynamicToolCall',
      namespace: 'functions',
      tool: 'exec',
      success: false,
      arguments: { code: 'await tools.exec_command({cmd: "secret"});\nawait tools.other()' },
      contentItems: [{ type: 'inputText', text: 'nested output' }],
    });
    expect(fact).toMatchObject({
      family: 'executionWrapper',
      status: 'failed',
      bytes: { deliveredScope: 'serializedDynamicContent' },
    });
    expect(JSON.stringify(fact)).not.toMatch(/secret|nested|exec_command/);
    expect(tool({ type: 'dynamicToolCall', success: false }).bytes.delivered.value).toBeNull();
  });

  it('does not infer retry/reuse from repeated calls, command bodies or output claims', () => {
    const input = {
      status: 'failed',
      aggregatedOutput: 'retry 2; cache hit; saved 99% tokens',
      command: 'retry grep',
    };
    expect(tool(input)).toEqual(tool(input));
    expect(tool(input)).toMatchObject({
      retries: { value: null, source: null },
      reuse: { value: null, source: null },
    });
    expect(tool({ ...input, id: 'retry-call' }).eventKey).not.toBe(tool(input).eventKey);
  });

  it('provides stable replay identity while separating phase, runtime and physical child', () => {
    const input = {
      method: 'item/completed',
      params: {
        threadId: 'root',
        turnId: 'root-turn',
        item: { id: 'call', type: 'commandExecution' },
      },
    };
    const decode = (options = correlation) =>
      decodeToolEfficiencyFacts('session', at, input, options)[0] as ToolEfficiencyFact;
    const root = decode();
    expect(root.eventKey).toBe(decode().eventKey);
    expect(tool({}, 'item/started').eventKey).not.toBe(root.eventKey);
    expect(decode({ ...correlation, runtimeId: 'runtime-2' }).eventKey).not.toBe(root.eventKey);
    const child = decodeToolEfficiencyFacts('session', at, input, {
      ...correlation,
      physicalThreadId: 'child',
      physicalTurnId: 'child-turn',
    })[0] as ToolEfficiencyFact;
    expect(child.identity).toMatchObject({
      actor: 'child',
      threadId: 'child',
      turnId: 'child-turn',
    });
    expect(child.eventKey).not.toBe(root.eventKey);
    expect(decodeToolEfficiencyFacts('session', at, input)[0] as ToolEfficiencyFact).toMatchObject({
      eventKey: null,
      identity: { actor: 'unknown', runtimeId: null },
    });
  });

  it('reads only documented context-mode envelope quality, keeping display and capture distinct', () => {
    const fact = contextMode(
      {
        operationId: 'operation',
        captureCompleteness: 'complete',
        evidenceCompleteness: 'complete',
        omittedBytes: 1000,
        audit: { bytes: 1000 },
        failures: { firstFailure: { cause: 'secret' } },
      },
      'output',
    );
    expect(fact).toMatchObject({
      family: 'contextMode',
      completeness: {
        capture: { value: 'complete' },
        evidence: { value: 'complete' },
        display: { value: null },
      },
      truncated: { value: null },
      bytes: { raw: { value: null }, processed: { value: null } },
    });
    expect(JSON.stringify(fact)).not.toMatch(/secret|operation|1000|output/);
    const budget = tool({
      type: 'mcpToolCall',
      server: 'context-mode',
      tool: 'ctx_execute',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              displayCompleteness: 'partial',
              captureCompleteness: 'complete',
              evidenceCompleteness: 'partial',
              overflow: { report: 'report-id' },
              preview: 'private',
            }),
          },
        ],
      },
    });
    expect(budget).toMatchObject({
      truncated: { value: true },
      completeness: {
        capture: { value: 'complete' },
        display: { value: 'partial' },
        evidence: { value: 'partial' },
      },
    });
    expect(JSON.stringify(budget)).not.toMatch(/private|report-id/);
  });

  it('ignores nested, malformed, oversized and unrecognized quality claims', () => {
    const nested = JSON.stringify({ operationId: 'nested', captureCompleteness: 'complete' });
    expect(contextMode({}, `Execution: ${nested}`).completeness.capture.value).toBeNull();
    expect(
      contextMode({ operationId: 'outer', preview: `Execution: ${nested}` }).completeness.capture
        .value,
    ).toBeNull();
    expect(
      contextMode({ operationId: 'outer', captureCompleteness: 'invented' }).completeness.capture
        .value,
    ).toBeNull();
    expect(
      contextMode({
        operationId: 'outer',
        private: 'x'.repeat(17_000),
        captureCompleteness: 'complete',
      }).completeness.capture.value,
    ).toBeNull();
    expect(
      tool({
        type: 'mcpToolCall',
        server: 'other',
        tool: 'ctx_execute',
        result: { content: [{ type: 'text', text: `Execution: ${nested}` }] },
      }).completeness.capture.value,
    ).toBeNull();
    expect(
      tool({
        type: 'mcpToolCall',
        server: 'context-mode',
        tool: 'ctx_execute',
        result: { content: [{ type: 'text', text: 'Execution: broken' }] },
      }).completeness.capture.value,
    ).toBeNull();
  });

  it('keeps actual partial provider token measurements independent from tool cost', () => {
    const facts = decodeToolEfficiencyFacts(
      'session',
      at,
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'root',
          turnId: 'turn',
          tokenUsage: {
            last: { totalTokens: 0, inputTokens: 12, cachedInputTokens: -1 },
            total: { outputTokens: 3 },
          },
        },
      },
      correlation,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: 'providerUsage',
      scope: 'threadUsageSnapshot',
      last: {
        totalTokens: { value: 0, unit: 'tokens', source: 'tokenUsage.last.totalTokens' },
        inputTokens: { value: 12 },
        cachedInputTokens: { value: null },
        outputTokens: { value: null },
      },
      total: { outputTokens: { value: 3 } },
    });
    expect(facts[0]).not.toHaveProperty('itemId');
    expect(tool({ tokenUsage: { totalTokens: 99 } })).not.toHaveProperty('tokens');
    expect(
      decodeToolEfficiencyFacts('session', at, {
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'root', tokenUsage: {} },
      }),
    ).toEqual([]);
  });

  it('accepts bounded legacy collaboration metadata without retaining prompts or child messages', () => {
    expect(
      tool({
        type: 'collabToolCall',
        prompt: 'secret',
        agentsStates: { child: { message: 'private' } },
      }),
    ).toMatchObject({ family: 'collaboration', coverage: 'unknown' });
    expect(JSON.stringify(tool({ type: 'collabAgentToolCall', prompt: 'secret' }))).not.toContain(
      'secret',
    );
  });

  it('rejects unsupported, invalid and hostile events without retaining content', () => {
    for (const type of ['agentMessage', 'reasoning', 'futureTool'])
      expect(
        decodeToolEfficiencyFacts('session', at, {
          method: 'item/completed',
          params: { item: { type, id: 'call', text: 'private' } },
        }),
      ).toEqual([]);
    expect(
      decodeToolEfficiencyFacts('session', at, { method: 'item/completed', params: null }),
    ).toEqual([]);
    expect(
      decodeToolEfficiencyFacts('session', 'invalid', { method: 'item/completed', params: {} }),
    ).toEqual([]);
    expect(
      decodeToolEfficiencyFacts('session', at, {
        method: 'item/completed',
        params: { item: { type: 'commandExecution', id: 'x'.repeat(257) } },
      }),
    ).toEqual([]);
    expect(
      decodeToolEfficiencyFacts('session', at, {
        method: 'item/completed',
        params: { item: { type: 'commandExecution', id: 'secret\nvalue' } },
      }),
    ).toEqual([]);
    const circular: unknown[] = [];
    circular.push(circular);
    expect(
      tool({ type: 'mcpToolCall', result: { content: circular } }).bytes.delivered.value,
    ).toBeNull();
  });
});
