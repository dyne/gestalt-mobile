/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { normalizeCodexNotification } from './normalizer.js';

describe('normalizeCodexNotification', () => {
  it('maps an agent message delta to a stable relay event', () => {
    expect(
      normalizeCodexNotification('s', 1, '2026-01-01T00:00:00.000Z', {
        method: 'item/agentMessage/delta',
        params: { delta: 'hello' },
      }),
    ).toEqual({
      sessionId: 's',
      sequence: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      type: 'agentMessageDelta',
      payload: { text: 'hello' },
    });
  });

  it('keeps agent item identity and phase through its live lifecycle', () => {
    expect(
      normalizeCodexNotification(
        's',
        2,
        '2026-01-01T00:00:00.000Z',
        {
          method: 'item/started',
          params: { item: { id: 'message-1', type: 'agentMessage', phase: 'commentary' } },
        },
        '/workspace',
        'turn-1',
      ),
    ).toMatchObject({
      type: 'agentMessageStarted',
      payload: { itemId: 'message-1', text: '', phase: 'commentary', turnId: 'turn-1' },
    });
    expect(
      normalizeCodexNotification(
        's',
        3,
        '2026-01-01T00:00:00.000Z',
        {
          method: 'item/completed',
          params: {
            item: {
              id: 'message-1',
              type: 'agentMessage',
              text: 'Checking the workspace.',
              phase: 'commentary',
            },
          },
        },
        '/workspace',
        'turn-1',
      ),
    ).toMatchObject({
      type: 'agentMessageCompleted',
      payload: {
        itemId: 'message-1',
        text: 'Checking the workspace.',
        phase: 'commentary',
        turnId: 'turn-1',
      },
    });
  });

  it('prefers the notification turn over stale session and item ownership', () => {
    expect(
      normalizeCodexNotification(
        's',
        4,
        '2026-01-01T00:00:00.000Z',
        {
          method: 'item/completed',
          params: {
            turnId: 'notification-turn',
            item: {
              id: 'message-2',
              type: 'agentMessage',
              text: 'Done.',
              phase: 'final_answer',
              turnId: 'item-turn',
            },
          },
        },
        '/workspace',
        'session-turn',
      ),
    ).toMatchObject({
      type: 'agentMessageCompleted',
      payload: { turnId: 'notification-turn' },
    });

    expect(
      normalizeCodexNotification(
        's',
        5,
        '2026-01-01T00:00:00.000Z',
        {
          method: 'item/started',
          params: {
            turnId: 'notification-turn',
            item: {
              id: 'command-2',
              type: 'commandExecution',
              command: 'npm test',
              turnId: 'item-turn',
            },
          },
        },
        '/workspace',
        'session-turn',
      ),
    ).toMatchObject({
      type: 'activity.updated',
      payload: { turnId: 'notification-turn' },
    });
  });

  it('maps a command lifecycle item without its raw output', () => {
    expect(
      normalizeCodexNotification('s', 2, '2026-01-01T00:00:00.000Z', {
        method: 'item/completed',
        params: {
          item: {
            id: 'item-1',
            type: 'commandExecution',
            command: 'git status',
            status: 'completed',
            aggregatedOutput: 'secret output',
          },
        },
      }),
    ).toMatchObject({
      type: 'activity.updated',
      payload: { id: 'item-1', label: 'Command · completed', detail: 'git status' },
    });
  });

  it.each([
    ['mcp__context_mode__ctx_execute', 'completed'],
    ['mcp__gestalt_context_mode__ctx_search', 'failed'],
  ])('keeps a provider-prefixed MCP tool identifier and status', (tool, status) => {
    expect(
      normalizeCodexNotification('s', 3, '2026-01-01T00:00:00.000Z', {
        method: 'item/completed',
        params: { item: { id: tool, type: 'mcpToolCall', tool, status } },
      }),
    ).toMatchObject({
      type: 'activity.updated',
      payload: { id: tool, label: `Tool · ${status}`, detail: tool },
    });
  });

  it('maps structured reasoning summary parts from a completed item', () => {
    expect(
      normalizeCodexNotification('s', 3, '2026-01-01T00:00:00.000Z', {
        method: 'item/completed',
        params: {
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            summary: [
              { type: 'summary_text', text: 'Checked the workspace.' },
              { type: 'summary_text', text: 'Implemented the change.' },
            ],
          },
        },
      }),
    ).toMatchObject({
      type: 'activity.updated',
      payload: {
        id: 'reasoning-1',
        label: 'Reasoning summary',
        detail: 'Checked the workspace.\nImplemented the change.',
      },
    });
  });

  it('omits a completed reasoning item without readable summary text', () => {
    expect(
      normalizeCodexNotification('s', 4, '2026-01-01T00:00:00.000Z', {
        method: 'item/completed',
        params: { item: { id: 'reasoning-1', type: 'reasoning', summary: [] } },
      }),
    ).toBeNull();
  });

  it('keeps file changes with workspace-relative paths', () => {
    expect(
      normalizeCodexNotification(
        's',
        5,
        '2026-01-01T00:00:00.000Z',
        {
          method: 'item/completed',
          params: {
            item: {
              id: 'change-1',
              type: 'fileChange',
              status: 'completed',
              changes: [
                {
                  path: '/workspace/src/app.ts',
                  diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more',
                },
              ],
            },
          },
        },
        '/workspace',
      ),
    ).toMatchObject({
      type: 'activity.updated',
      payload: {
        id: 'change-1',
        label: 'File change · completed',
        detail: 'src/app.ts',
        changes: [{ path: 'src/app.ts', additions: 2, deletions: 1 }],
      },
    });
  });

  it('refreshes an in-progress file activity from a patch update notification', () => {
    expect(
      normalizeCodexNotification(
        's',
        6,
        '2026-01-01T00:00:01.000Z',
        {
          method: 'item/fileChange/patchUpdated',
          params: {
            itemId: 'change-1',
            turnId: 'turn-1',
            changes: [{ path: '/workspace/src/app.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
          },
        },
        '/workspace',
      ),
    ).toMatchObject({
      type: 'activity.updated',
      payload: {
        id: 'change-1',
        turnId: 'turn-1',
        label: 'File change · in_progress',
        changes: [{ path: 'src/app.ts', additions: 1, deletions: 1 }],
      },
    });
  });

  it('never projects child or unknown agent text, but assigns known child work to the root turn', () => {
    const child = {
      kind: 'child' as const,
      physicalThreadId: 'child-thread',
      physicalTurnId: 'child-turn',
    };
    expect(
      normalizeCodexNotification(
        's',
        7,
        '2026-01-01T00:00:02.000Z',
        {
          method: 'item/completed',
          params: {
            turnId: 'child-turn',
            item: {
              id: 'child-final',
              type: 'agentMessage',
              text: 'private executor final',
              phase: 'final_answer',
            },
          },
        },
        '/workspace',
        'root-turn',
        child,
      ),
    ).toBeNull();
    expect(
      normalizeCodexNotification(
        's',
        8,
        '2026-01-01T00:00:02.000Z',
        {
          method: 'item/completed',
          params: {
            turnId: 'child-turn',
            item: {
              id: 'child-command',
              type: 'commandExecution',
              command: 'npm test',
              status: 'completed',
            },
          },
        },
        '/workspace',
        'root-turn',
        child,
      ),
    ).toMatchObject({
      type: 'activity.updated',
      payload: { turnId: 'root-turn', actorTurnId: 'child-turn' },
    });
    expect(
      normalizeCodexNotification(
        's',
        9,
        '2026-01-01T00:00:02.000Z',
        {
          method: 'item/agentMessage/delta',
          params: { turnId: 'unknown-turn', delta: 'must not leak' },
        },
        '/workspace',
        'root-turn',
        { kind: 'unknown' },
      ),
    ).toBeNull();
  });
});
