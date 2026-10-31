/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  decodeMcpStartupFailure,
  observedMcpStartupFailure,
  McpStartupTracker,
} from './mcp-startup-failure.js';
import {
  parseMcpStartupFailure,
  parseMcpStartupStatus,
  mcpStartupActivity,
} from '../../../shared/contracts/mcp-startup-failure.js';

const correlation = {
  failureId: 'failure-1',
  attemptId: 'attempt-1',
  occurredAt: '2026-10-26T17:00:00.000Z',
  threadId: 'child-1',
};
const decode = (params: unknown, method = 'mcpServer/startupStatus/updated') =>
  decodeMcpStartupFailure({ method, params }, correlation);

describe('bounded MCP startup failure evidence', () => {
  it('distinguishes local pending readiness and allowlisted failures from upstream MCP failures', () => {
    const tracker = new McpStartupTracker();
    const pending = tracker.observeReadiness('starting')!;
    expect(pending).toMatchObject({ status: 'starting', phase: 'readiness', failure: null });
    const failed = tracker.observeReadiness('failed', 'authentication-failed')!;
    expect(failed.attemptId).toBe(pending.attemptId);
    expect(failed.failure).toMatchObject({
      phase: 'readiness',
      code: 'readiness-failed',
      readinessReason: 'authentication-failed',
      exitCode: null,
      signal: null,
    });
    expect(parseMcpStartupStatus(failed)).toEqual(failed);
    tracker.observeReadiness('starting');
    const unknown = tracker.observeReadiness('failed', 'private key and stderr')!;
    expect(unknown.failure?.readinessReason).toBe('unknown');
    expect(JSON.stringify(unknown)).not.toContain('private');
    const upstream = decode({
      name: 'gestalt-xerj',
      status: 'failed',
      phase: 'readiness',
      code: 'readiness-failed',
      readinessReason: 'authentication-failed',
    })!;
    expect(upstream).toMatchObject({ phase: 'startup', code: 'startup-failed' });
    expect(upstream.readinessReason).toBeUndefined();
    expect(
      parseMcpStartupFailure({ ...failed.failure, serverName: 'context-mode' }),
    ).toBeUndefined();
    expect(parseMcpStartupFailure({ ...failed.failure, phase: 'startup' })).toBeUndefined();
  });
  it('correlates attempts, deduplicates their first failure, and isolates concurrent tools', () => {
    const tracker = new McpStartupTracker();
    const observe = (status: string, name = 'context-mode', threadId = 'child') =>
      tracker.observe({
        method: 'mcpServer/startupStatus/updated',
        params: { status, name, threadId },
      });
    const first = observe('failed')!;
    expect(observe('failed')).toBeUndefined();
    expect(observe('cancelled')).toBeUndefined();
    const other = observe('failed', 'gestalt-serena')!;
    const otherChild = observe('failed', 'context-mode', 'other-child')!;
    const next = observe('starting')!;
    const second = observe('failed')!;
    expect(second.attemptId).toBe(next.attemptId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.failure?.failureId).not.toBe(first.failure?.failureId);
    const ready = observe('ready')!;
    expect(ready.failure).toBeNull();
    expect(ready.attemptId).toBe(second.attemptId);
    expect(mcpStartupActivity(ready).id).toBe(mcpStartupActivity(first).id);
    expect(mcpStartupActivity(other).id).not.toBe(mcpStartupActivity(first).id);
    expect(mcpStartupActivity(otherChild).id).not.toBe(mcpStartupActivity(first).id);
    expect(observe('ready')).toBeUndefined();
    const restarted = new McpStartupTracker().observe({
      method: 'mcpServer/startupStatus/updated',
      params: { status: 'ready', name: 'context-mode', threadId: 'child' },
    })!;
    expect(restarted.runtimeId).not.toBe(ready.runtimeId);
    expect(mcpStartupActivity(restarted).id).toBe(mcpStartupActivity(ready).id);
  });

  it('keeps unattributed telemetry explicit, bounds tracked identities, and rejects inconsistent correlations', () => {
    const tracker = new McpStartupTracker();
    const notify = (threadId?: string) => ({
      method: 'mcpServer/startupStatus/updated',
      params: {
        status: 'failed',
        name: 'context-mode',
        ...(threadId === undefined ? {} : { threadId }),
      },
    });
    expect(tracker.observe(notify('private\nthread'))).toBeUndefined();
    const unattributed = tracker.observe(notify())!;
    expect(unattributed.threadId).toBeNull();
    expect(unattributed.failure?.threadId).toBeNull();
    for (const field of ['runtimeId', 'attemptId', 'serverName', 'threadId', 'observedAt'])
      expect(parseMcpStartupStatus({ ...unattributed, [field]: 'different' })).toBeUndefined();
    for (let index = 0; index < 255; index++)
      expect(tracker.observe(notify(`child-${index}`))).toBeDefined();
    expect(tracker.observe(notify('overflow'))).toBeUndefined();
    expect(JSON.stringify(unattributed)).not.toContain('private');
  });
  it.each(['mcpServer/startupStatus/updated', 'mcpServer/statusUpdated'])(
    'supports %s without guessing the initialize outcome',
    (method) => {
      expect(
        decode(
          {
            name: 'context-mode',
            status: 'failed',
            threadId: 'child-2',
            error: 'initialize timeout, process exited 1: secret',
            exitCode: 1,
            signal: 'SIGKILL',
          },
          method,
        ),
      ).toEqual({
        ...correlation,
        schemaVersion: 1,
        threadId: 'child-2',
        serverName: 'context-mode',
        phase: 'startup',
        code: 'startup-failed',
        runtimeId: null,
        artifactDigest: null,
        exitCode: null,
        signal: null,
      });
    },
  );

  it.each([
    { phase: 'spawn', code: 'process-exited', exitCode: 23, signal: null },
    { phase: 'initialize', code: 'process-exited', exitCode: null, signal: 'SIGTERM' },
    { phase: 'initialize', code: 'process-exited', exitCode: null, signal: null },
    { phase: 'initialize', code: 'protocol-rejected' },
    { phase: 'initialize', code: 'timeout' },
    { phase: 'artifact', code: 'artifact-unavailable' },
  ] as const)('retains the directly observed $phase / $code boundary', (observation) => {
    const failure = observedMcpStartupFailure(correlation, {
      serverName: 'gestalt-serena',
      ...observation,
    });
    expect(failure).toMatchObject({
      ...correlation,
      ...observation,
      exitCode: 'exitCode' in observation ? observation.exitCode : null,
      signal: 'signal' in observation ? observation.signal : null,
    });
    expect(failure?.runtimeId).toBeNull();
    expect(failure?.artifactDigest).toBeNull();
  });

  it('retains only the upstream structured reason and cancellation', () => {
    expect(
      decode({ name: 'gestalt-xerj', status: 'failed', failureReason: 'reauthenticationRequired' })
        ?.code,
    ).toBe('reauthentication-required');
    expect(decode({ name: 'gestalt-xerj', status: 'failed', failureReason: 'secret' })?.code).toBe(
      'startup-failed',
    );
    expect(decode({ name: 'gestalt-xerj', status: 'cancelled' })?.code).toBe('cancelled');
  });

  it('ignores successful, unrelated and malformed notifications', () => {
    for (const params of [null, [], 'secret', {}, { name: 'context-mode', status: 'ready' }])
      expect(decode(params)).toBeUndefined();
    expect(decode({ name: 'secret', status: 'failed' })).toBeUndefined();
    expect(decode({ name: 'context-mode', status: 'failed' }, 'item/completed')).toBeUndefined();
  });

  it('drops malicious strings and extra fields at the export contract boundary', () => {
    const initial = decode({ name: 'context-mode', status: 'failed' })!;
    const failure = parseMcpStartupFailure({
      ...initial,
      runtimeId: 'token=secret\n',
      artifactDigest: '/private/secret.js',
      threadId: 'secret prompt with spaces',
      exitCode: 'secret',
      signal: 'SIGSECRET',
      environment: { TOKEN: 'secret' },
      stderr: 'secret',
      error: 'secret',
      prompt: 'secret',
      output: 'secret',
      additionalDetails: 'secret',
    });
    expect(failure).toEqual({
      ...initial,
      threadId: null,
    });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });

  it('preserves known opaque runtime and content digest identities', () => {
    const artifactDigest = `sha256:${'a'.repeat(64)}`;
    const failure = decodeMcpStartupFailure(
      {
        method: 'mcpServer/startupStatus/updated',
        params: { name: 'context-mode', status: 'failed' },
      },
      { ...correlation, runtimeId: 'runtime-1', artifactDigest },
    );
    expect(failure).toMatchObject({ runtimeId: 'runtime-1', artifactDigest });
  });

  it('enforces field bounds, exact enums, UTC validity and explicit unknown numeric values', () => {
    const initial = decode({ name: 'context-mode', status: 'failed' })!;
    for (const field of ['failureId', 'attemptId', 'serverName', 'phase', 'code', 'occurredAt']) {
      expect(parseMcpStartupFailure({ ...initial, [field]: 'x'.repeat(129) })).toBeUndefined();
      expect(parseMcpStartupFailure({ ...initial, [field]: 'secret\nvalue' })).toBeUndefined();
    }
    for (const occurredAt of ['2026-02-30T00:00:00.000Z', '2026-10-26', 'invalid'])
      expect(parseMcpStartupFailure({ ...initial, occurredAt })).toBeUndefined();
    for (const exitCode of [-1, 256, 1.2, NaN, Infinity, undefined])
      expect(parseMcpStartupFailure({ ...initial, exitCode })?.exitCode).toBeNull();
    expect(parseMcpStartupFailure({ ...initial, exitCode: 0 })?.exitCode).toBe(0);
    const longest = parseMcpStartupFailure({
      ...initial,
      failureId: 'x'.repeat(128),
      attemptId: 'x'.repeat(128),
      threadId: 'x'.repeat(128),
      runtimeId: 'x'.repeat(128),
      artifactDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(Buffer.byteLength(JSON.stringify(longest))).toBeLessThan(1024);
  });
});
