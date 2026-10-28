/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { handleHostTestTool } from './handle-tool.js';
const context = { sessionId: 'session', workspace: '/workspace', root: true, provider: 'codex' };
const runId = '00000000-0000-4000-8000-000000000001';

it('waits once for a running owned run and returns completed evidence without polling', async () => {
  const runner = {
    request: vi.fn().mockResolvedValue({ runId, state: 'running' }),
    cancelSession: vi.fn(),
    close: vi.fn(),
  };
  const waitForRun = vi.fn().mockReturnValue(true);
  expect(
    await handleHostTestTool(runner, { ...context, waitForRun }, { operation: 'wait', runId }),
  ).toEqual({ accepted: true, runId });
  expect(waitForRun).toHaveBeenCalledExactlyOnceWith(runId, 600_000);
  const result = { runId, state: 'passed', exitCode: 0 };
  runner.request.mockResolvedValue(result);
  expect(
    await handleHostTestTool(runner, { ...context, waitForRun }, { operation: 'wait', runId }),
  ).toMatchObject({ accepted: false, next: 'continueSameTurn', reason: 'runCompleted', result });
  expect(waitForRun).toHaveBeenCalledOnce();
  expect(runner.request).toHaveBeenCalledTimes(2);
});

it('handles completion during registration and rejects missing, foreign or unavailable waits', async () => {
  const runner = {
    request: vi
      .fn()
      .mockResolvedValueOnce({ runId, state: 'running' })
      .mockResolvedValueOnce({ runId, state: 'passed' }),
    cancelSession: vi.fn(),
    close: vi.fn(),
  };
  expect(
    await handleHostTestTool(
      runner,
      { ...context, waitForRun: () => 'wakeAlreadySatisfied' },
      { operation: 'wait', runId },
    ),
  ).toMatchObject({ accepted: false, result: { state: 'passed' } });
  runner.request.mockResolvedValue({ error: 'runNotFound' });
  const waitForRun = vi.fn();
  expect(
    await handleHostTestTool(
      runner,
      { ...context, root: false, waitForRun },
      { operation: 'wait', runId },
    ),
  ).toEqual({ error: 'rootSupervisorRequired' });
  expect(
    await handleHostTestTool(runner, { ...context, waitForRun }, { operation: 'wait', runId }),
  ).toEqual({ error: 'runNotFound' });
  expect(waitForRun).not.toHaveBeenCalled();
  runner.request.mockResolvedValue({ runId, state: 'running' });
  expect(await handleHostTestTool(runner, context, { operation: 'wait', runId })).toMatchObject({
    accepted: false,
    reason: 'automaticContinuationUnavailable',
  });
  for (const maxWaitMs of [0, 59_999, 86_400_001, 60_000.5]) {
    expect(
      await handleHostTestTool(runner, context, { operation: 'wait', runId, maxWaitMs }),
    ).toEqual({ error: 'invalidRequest' });
  }
});
it('binds host operations to the runtime root and rejects caller-supplied commands', async () => {
  const runner = {
    request: vi.fn().mockResolvedValue({ suites: [] }),
    cancelSession: vi.fn(),
    close: vi.fn(),
  };
  expect(
    await handleHostTestTool(runner, { ...context, root: false }, { operation: 'list' }),
  ).toEqual({ error: 'rootSupervisorRequired' });
  expect(
    await handleHostTestTool(runner, { ...context, provider: 'kimi' }, { operation: 'list' }),
  ).toEqual({ error: 'rootSupervisorRequired' });
  expect(
    await handleHostTestTool(runner, context, { operation: 'list', command: 'anything' }),
  ).toEqual({ error: 'invalidRequest' });
  expect(runner.request).not.toHaveBeenCalled();
  expect(await handleHostTestTool(undefined, context, { operation: 'list' })).toEqual({
    error: 'hostTestRunnerDisabled',
  });
  expect(await handleHostTestTool(runner, context, { operation: 'list' })).toEqual({ suites: [] });
  expect(runner.request).toHaveBeenCalledWith(
    { sessionId: 'session', workspace: '/workspace' },
    { operation: 'list' },
  );
});
