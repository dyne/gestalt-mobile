import { describe, expect, it } from 'vitest';

import { toChatItems } from './history-mapper.js';

describe('toChatItems', () => {
  it('maps supported Codex thread items without exposing generated types', () => {
    expect(
      toChatItems([
        { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'a', type: 'agentMessage', text: 'hi', phase: 'final' },
        { id: 'c', type: 'commandExecution', command: 'git status', status: 'completed', exitCode: 0 },
        { id: 'x', type: 'imageView', path: '/tmp/image' },
      ]),
    ).toEqual([
      { id: 'u', kind: 'user', text: 'hello' },
      { id: 'a', kind: 'agent', text: 'hi', phase: 'final_answer' },
      { id: 'c', kind: 'command', command: 'git status', status: 'completed', exitCode: 0 },
    ]);
  });
});
