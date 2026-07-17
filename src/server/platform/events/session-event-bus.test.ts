/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { SessionEventBus } from './session-event-bus.js';
describe('SessionEventBus', () => {
  it('isolates subscriptions by session', () => {
    const bus = new SessionEventBus();
    const received: number[] = [];
    bus.subscribe('s', (event) => received.push(event.sequence));
    bus.publish({ sessionId: 'other', sequence: 1, type: 'x', occurredAt: 't', payload: {} });
    bus.publish({ sessionId: 's', sequence: 2, type: 'x', occurredAt: 't', payload: {} });
    expect(received).toEqual([2]);
  });
});
