/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { handleHostTestTool } from './handle-tool.js';
const context = { sessionId: 'session', workspace: '/workspace', root: true, provider: 'codex' };
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
