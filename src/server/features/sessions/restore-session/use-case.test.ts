import { describe, expect, it } from 'vitest';
import { canRestore } from './use-case.js';
describe('canRestore', () => {
  it('requires a persisted thread and no active turn', () => {
    expect(canRestore({ threadId: null, state: 'ready' } as never)).toBe(false);
    expect(canRestore({ threadId: 't', state: 'turnActive' } as never)).toBe(false);
  });
});
