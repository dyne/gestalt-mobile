import { describe, expect, it } from 'vitest';
import { applyDelta } from './message-store.js';
describe('applyDelta', () => {
  it('accumulates a streamed assistant message', () => {
    expect(applyDelta(applyDelta([], 'm', 'hello'), 'm', ' world')[0]?.text).toBe('hello world');
  });
});
