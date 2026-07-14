import { describe, expect, it } from 'vitest';
import { canonicalHistory } from './use-case.js';
describe('canonicalHistory', () => {
  it('orders replay history by durable sequence', () =>
    expect(
      canonicalHistory([
        { sessionId: 's', sequence: 2, type: 'x', occurredAt: 't', payload: {} },
        { sessionId: 's', sequence: 1, type: 'x', occurredAt: 't', payload: {} },
      ]).map((event) => event.sequence),
    ).toEqual([1, 2]));
});
