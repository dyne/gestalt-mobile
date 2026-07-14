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
});
