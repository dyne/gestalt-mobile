/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { decodeAgentActivityFact } from './activity-facts.js';
const at = '2026-01-01T00:00:00.000Z';
describe('agent activity app-server characterization', () => {
  it('maps bounded current root and collaboration shapes', () => {
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'thread/started',
        params: { thread: { id: 'root', status: { type: 'active' } } },
      }),
    ).toMatchObject({ kind: 'threadStarted', threadId: 'root', status: 'active' });
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'thread/status/changed',
        params: { threadId: 'root', status: { type: 'active', activeFlags: [] } },
      }),
    ).toMatchObject({ kind: 'threadStatus', threadId: 'root' });
    for (const tool of ['spawn_agent', 'send_input', 'resume_agent', 'wait', 'close_agent'])
      expect(
        decodeAgentActivityFact('s', at, {
          method: 'item/started',
          params: {
            item: {
              type: 'collabToolCall',
              tool,
              status: 'inProgress',
              senderThreadId: 'root',
              receiverThreadId: 'child',
              agentStatus: 'working',
            },
          },
        }),
      ).toMatchObject({
        kind: 'collaboration',
        childId: 'child',
        threadId: 'root',
        collaborationAction: tool,
      });
  });
  it('fails closed for missing metadata, unknown methods and hostile identifiers', () => {
    expect(decodeAgentActivityFact('s', at, { method: 'thread/started', params: {} })).toBeNull();
    expect(decodeAgentActivityFact('s', at, { method: 'future/event', params: {} })).toBeNull();
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'turn/completed',
        params: { turn: { id: 'x'.repeat(257) } },
      }),
    ).toBeNull();
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'item/completed',
        params: { item: { type: 'collabToolCall', tool: 'wait', status: 'failed' } },
      }),
    ).toMatchObject({ kind: 'collaboration', childStatus: 'failed' });
  });
  it('keeps optional omissions and unknown future status bounded', () => {
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'thread/started',
        params: { thread: { id: 'root' } },
      }),
    ).toMatchObject({ kind: 'threadStarted', threadId: 'root' });
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'thread/status/changed',
        params: { threadId: 'root', status: { type: 'future' } },
      }),
    ).toMatchObject({ status: 'future' });
    const fact = decodeAgentActivityFact('s', at, {
      method: 'item/completed',
      params: {
        item: {
          type: 'collabToolCall',
          tool: 'close_agent',
          senderThreadId: 'root',
          receiverThreadId: 'child',
          status: 'failed',
        },
      },
    });
    expect(fact).toMatchObject({ childId: 'child', childStatus: 'failed' });
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'turn/started',
        params: { turn: { id: 'ambiguous' } },
      }),
    ).toBeNull();
  });
  it('decodes duplicate and reordered collaboration completion deterministically', () => {
    const input = {
      method: 'item/completed',
      params: {
        item: {
          type: 'collabToolCall',
          tool: 'wait',
          senderThreadId: 'root',
          receiverThreadId: 'child',
          status: 'completed',
        },
      },
    };
    expect(decodeAgentActivityFact('s', at, input)).toEqual(
      decodeAgentActivityFact('s', at, input),
    );
    expect(
      decodeAgentActivityFact('s', at, { method: 'item/started', params: input.params }),
    ).toMatchObject({ childId: 'child' });
  });
  it('does not accept oversized collaboration correlation identifiers', () => {
    expect(
      decodeAgentActivityFact('s', at, {
        method: 'item/started',
        params: {
          item: {
            type: 'collabToolCall',
            tool: 'spawn_agent',
            senderThreadId: 'x'.repeat(257),
            receiverThreadId: 'x'.repeat(257),
            newThreadId: 'x'.repeat(257),
          },
        },
      }),
    ).toMatchObject({ kind: 'collaboration' });
  });
});
