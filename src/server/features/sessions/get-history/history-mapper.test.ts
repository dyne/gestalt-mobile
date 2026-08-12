/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { toChatItems } from './history-mapper.js';

describe('toChatItems', () => {
  it('maps supported Codex thread items without exposing generated types', () => {
    expect(
      toChatItems([
        {
          startedAt: 1_784_102_400,
          completedAt: 1_784_102_520,
          items: [
            { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
            { id: 'a', type: 'agentMessage', text: 'hi', phase: 'final_answer' },
            {
              id: 'r',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'I checked the workspace.' }],
            },
            {
              id: 'c',
              type: 'commandExecution',
              command: 'git status',
              status: 'completed',
              exitCode: 0,
            },
            {
              id: 'f',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'src/app.ts' }, { path: 'src/app.test.ts' }],
            },
            { id: 'x', type: 'imageView', path: '/tmp/image' },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'u',
        kind: 'user',
        text: 'hello',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'a',
        kind: 'agent',
        text: 'hi',
        phase: 'final_answer',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_520_000,
      },
      {
        id: 'r',
        kind: 'reasoning',
        summary: ['I checked the workspace.'],
        turnId: 'history-turn-0',
      },
      {
        id: 'c',
        kind: 'command',
        command: 'git status',
        status: 'completed',
        exitCode: 0,
        turnId: 'history-turn-0',
      },
      {
        id: 'f',
        kind: 'fileChange',
        paths: ['src/app.ts', 'src/app.test.ts'],
        status: 'completed',
        turnId: 'history-turn-0',
      },
    ]);
  });
});
