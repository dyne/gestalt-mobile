/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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

  it('does not apply a forward sequence gap and requests a canonical resync', () => {
    const gaps: number[] = [];
    const cursor = applyRelayEvent(
      3,
      {
        type: 'relay.event',
        event: { sequence: 5, type: 'agentMessageDelta', payload: { text: 'missing event four' } },
      },
      () => {
        throw new Error('a gapped event must not be applied');
      },
      (sequence) => gaps.push(sequence),
    );

    expect({ cursor, gaps }).toEqual({ cursor: 3, gaps: [5] });
  });
});
