/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { toChatItems } from './history-mapper.js';

describe('toChatItems', () => {
  it('maps only a durably correlated control as autopilot and rejects a spoofed prefix', () => {
    const turns = [
      {
        id: 'turn-genuine',
        startedAt: 1,
        completedAt: 1,
        items: [
          {
            id: 'genuine',
            type: 'userMessage',
            clientId: 'autopilot-1',
            content: [{ type: 'text', text: 'redacted' }],
          },
          {
            id: 'spoof',
            type: 'userMessage',
            // A manual client can deliberately collide with an exposed control ID.
            // Only the accepted synthetic turn correlation is authoritative.
            clientId: 'autopilot-1',
            content: [{ type: 'text', text: 'human' }],
          },
        ],
      },
      {
        id: 'turn-manual-collision',
        startedAt: 2,
        completedAt: 2,
        items: [
          {
            id: 'manual-collision',
            type: 'userMessage',
            clientId: 'autopilot-1',
            content: [{ type: 'text', text: 'must stay human' }],
          },
        ],
      },
    ];
    expect(toChatItems(turns, new Map([['turn-genuine', 'autopilot-1']]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'genuine', kind: 'autopilot', controlId: 'autopilot-1' }),
        expect.objectContaining({ id: 'spoof', kind: 'autopilot', controlId: 'autopilot-1' }),
        expect.objectContaining({ id: 'manual-collision', kind: 'user', text: 'must stay human' }),
      ]),
    );
  });
  it('maps supported Codex thread items without exposing generated types', () => {
    expect(
      toChatItems([
        {
          startedAt: 1_784_102_400,
          completedAt: 1_784_102_520,
          items: [
            {
              id: 'u',
              type: 'userMessage',
              clientId: 'operation-1',
              content: [{ type: 'text', text: 'hello' }],
            },
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
              changes: [
                { path: 'src/app.ts', additions: 5, deletions: 2 },
                { path: 'src/app.test.ts', additions: 8, deletions: 0 },
              ],
            },
            {
              id: 'm',
              type: 'mcpToolCall',
              tool: 'mcp__context_mode__ctx_execute',
              status: 'completed',
            },
            {
              id: 'm2',
              type: 'mcpToolCall',
              tool: 'mcp__gestalt_context_mode__ctx_search',
              status: 'failed',
            },
            { id: 'd', type: 'dynamicToolCall', tool: 'lookup_ticket', status: 'failed' },
            { id: 'x', type: 'imageView', path: '/tmp/image' },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'u',
        kind: 'user',
        text: 'hello',
        operationId: 'operation-1',
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
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'c',
        kind: 'command',
        command: 'git status',
        status: 'completed',
        exitCode: 0,
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'f',
        kind: 'fileChange',
        paths: ['src/app.ts', 'src/app.test.ts'],
        changes: [
          { path: 'src/app.ts', additions: 5, deletions: 2 },
          { path: 'src/app.test.ts', additions: 8, deletions: 0 },
        ],
        status: 'completed',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'm',
        kind: 'tool',
        name: 'mcp__context_mode__ctx_execute',
        status: 'completed',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'm2',
        kind: 'tool',
        name: 'mcp__gestalt_context_mode__ctx_search',
        status: 'failed',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'd',
        kind: 'tool',
        name: 'lookup_ticket',
        status: 'failed',
        turnId: 'history-turn-0',
        occurredAt: 1_784_102_400_000,
      },
    ]);
  });

  it('preserves the epoch timestamp for every renderable history item', () => {
    expect(
      toChatItems([
        {
          startedAt: 0,
          completedAt: 0,
          items: [
            { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
            { id: 'a', type: 'agentMessage', text: 'answer', phase: 'final_answer' },
            { id: 'r', type: 'reasoning', summary: ['reasoning'] },
            { id: 'p', type: 'plan', text: 'plan' },
            { id: 'c', type: 'commandExecution', command: 'true', status: 'completed' },
            { id: 'f', type: 'fileChange', changes: [{ path: 'file' }], status: 'completed' },
            { id: 't', type: 'mcpToolCall', tool: 'tool', status: 'completed' },
          ],
        },
      ]).map((item) => item.occurredAt),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
