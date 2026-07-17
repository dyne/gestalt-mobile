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
              changes: [{ path: '/workspace/src/app.ts' }],
            },
          },
        },
        '/workspace',
      ),
    ).toMatchObject({
      type: 'activity.updated',
      payload: { id: 'change-1', label: 'fileChange · completed', detail: 'src/app.ts' },
    });
  });
});
