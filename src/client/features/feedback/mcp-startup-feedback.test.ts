/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpStartupTracker } from '../../../server/platform/codex/mcp-startup-failure.js';
import { mcpStartupActivity } from '../../../shared/contracts/mcp-startup-failure.js';
import { createMcpStartupFeedback } from './mcp-startup-feedback.js';
import { createToastQueue } from './toast-queue.js';

describe('MCP startup toast pipeline', () => {
  afterEach(() => vi.useRealTimers());
  it('isolates current errors by session, child and tool, preserves history and ignores replayed failures', () => {
    vi.useFakeTimers();
    const queue = createToastQueue();
    const observe = createMcpStartupFeedback(queue);
    const tracker = new McpStartupTracker();
    const event = (status: string, name = 'context-mode', threadId = 'child') => ({
      type: 'activity.updated',
      payload: mcpStartupActivity(
        tracker.observe({
          method: 'mcpServer/startupStatus/updated',
          params: { status, name, threadId, error: 'private-secret' },
        })!,
      ),
    });
    const first = event('failed');
    observe('session', first);
    observe('session', first);
    observe('other-session', first);
    observe('session', event('failed', 'gestalt-serena'));
    observe('session', event('failed', 'context-mode', 'other-child'));
    expect(queue.snapshot()).toHaveLength(4);
    expect(queue.snapshot().filter((toast) => toast.kind === 'warning')).toHaveLength(1);
    observe('session', event('ready'));
    observe('session', first);
    expect(queue.snapshot()).toHaveLength(3);
    expect(queue.historySnapshot()).toHaveLength(4);
    expect(JSON.stringify(queue.historySnapshot())).not.toContain('private-secret');
    expect(
      queue.historySnapshot().some((toast) => toast.message.includes('Trace reference:')),
    ).toBe(true);
  });
  it('drops malformed diagnostics without creating feedback', () => {
    const queue = createToastQueue();
    createMcpStartupFeedback(queue)('s', {
      type: 'activity.updated',
      payload: { mcpStartup: { error: 'secret' } },
    });
    expect(queue.snapshot()).toEqual([]);
  });
});
