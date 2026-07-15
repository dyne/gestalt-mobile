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
            { id: 'x', type: 'imageView', path: '/tmp/image' },
          ],
        },
      ]),
    ).toEqual([
      { id: 'u', kind: 'user', text: 'hello', occurredAt: 1_784_102_400_000 },
      { id: 'a', kind: 'agent', text: 'hi', phase: 'final_answer', occurredAt: 1_784_102_520_000 },
      { id: 'r', kind: 'reasoning', summary: ['I checked the workspace.'] },
      { id: 'c', kind: 'command', command: 'git status', status: 'completed', exitCode: 0 },
    ]);
  });
});
