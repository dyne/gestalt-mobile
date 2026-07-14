import { describe, expect, it } from 'vitest';

import { applyRelayEvent } from './session-events-client.js';

describe('relay session events', () => {
  it('applies each sequenced agent delta once', () => {
    const applied: string[] = [];
    let cursor = 0;
    cursor = applyRelayEvent(
      cursor,
      {
        type: 'relay.event',
        event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'hello' } },
      },
      (text) => applied.push(text),
    );
    cursor = applyRelayEvent(
      cursor,
      {
        type: 'relay.event',
        event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'duplicate' } },
      },
      (text) => applied.push(text),
    );
    expect({ cursor, applied }).toEqual({ cursor: 1, applied: ['hello'] });
  });
});
