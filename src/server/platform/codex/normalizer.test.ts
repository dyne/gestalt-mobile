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

  it('maps a command lifecycle item without its raw output', () => {
    expect(
      normalizeCodexNotification('s', 2, '2026-01-01T00:00:00.000Z', {
        method: 'item/completed',
        params: { item: { id: 'item-1', type: 'commandExecution', command: 'git status', status: 'completed', aggregatedOutput: 'secret output' } },
      }),
    ).toMatchObject({ type: 'activity.updated', payload: { id: 'item-1', label: 'Command · completed', detail: 'git status' } });
  });
});
