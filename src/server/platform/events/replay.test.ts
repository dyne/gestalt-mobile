import { describe, expect, it } from 'vitest';
import { replayOrResync } from './replay.js';
describe('replayOrResync', () => {
  it('requests canonical resync across a pruned gap', () =>
    expect(
      replayOrResync([{ sessionId: 's', sequence: 5, type: 'x', occurredAt: 't', payload: {} }], 1),
    ).toEqual({ kind: 'resync' }));
});
