import { describe, expect, it } from 'vitest';
import { applyDelta, completeMessage } from './message-store.js';
describe('applyDelta', () => {
  it('accumulates a streamed assistant message', () => {
    expect(applyDelta(applyDelta([], 'm', 'hello'), 'm', ' world')[0]?.text).toBe('hello world');
  });
});

it('marks a streamed assistant message complete without changing its text', () => {
  expect(
    completeMessage(
      [{ id: 'assistant-session', role: 'assistant', text: 'Done', complete: false }],
      'assistant-session',
    ),
  ).toEqual([{ id: 'assistant-session', role: 'assistant', text: 'Done', complete: true }]);
});
