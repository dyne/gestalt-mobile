/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { hostTestRequest, type HostTestResult } from '../../../../shared/contracts/host-tests.js';
import type { HostTestRunner } from './ports.js';

/** Authority comes from the runtime's thread binding, never from tool arguments. */
export async function handleHostTestTool(
  runner: HostTestRunner | undefined,
  context: {
    sessionId: string;
    workspace: string;
    root: boolean;
    provider: string;
    waitForRun?: (runId: string, maxWaitMs: number) => boolean | 'wakeAlreadySatisfied';
  },
  args: unknown,
): Promise<unknown> {
  if (!context.root || context.provider !== 'codex') return { error: 'rootSupervisorRequired' };
  const parsed = hostTestRequest.safeParse(args);
  if (!parsed.success) return { error: 'invalidRequest' };
  if (!runner) return { error: 'hostTestRunnerDisabled' };
  try {
    if (parsed.data.operation === 'wait') {
      const { runId, maxWaitMs } = parsed.data;
      const owner = { sessionId: context.sessionId, workspace: context.workspace };
      const read = () =>
        runner.request(owner, { operation: 'status', runId }) as Promise<
          HostTestResult | { error: string }
        >;
      let result = await read();
      if ('error' in result) return result;
      const registration =
        result.state === 'running'
          ? context.waitForRun?.(runId, maxWaitMs)
          : 'wakeAlreadySatisfied';
      if (registration === true) return { accepted: true, runId };
      if (registration === 'wakeAlreadySatisfied' && result.state === 'running')
        result = await read();
      return {
        accepted: false,
        runId,
        next: 'continueSameTurn',
        reason:
          registration === 'wakeAlreadySatisfied'
            ? 'runCompleted'
            : 'automaticContinuationUnavailable',
        result,
      };
    }
    return await runner.request(
      { sessionId: context.sessionId, workspace: context.workspace },
      parsed.data,
    );
  } catch {
    // Never put test output, environment values or raw filesystem exceptions in chat.
    return { error: 'hostTestRunnerUnavailable' };
  }
}
