/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { decodeKimiActivityFacts } from './kimi-activity-facts.js';
import type { KimiEventContext } from './kimi-normalizer.js';
import type { KimiWsEvent } from './kimi-ws-client.js';

const NOW = '2026-09-22T00:00:00.000Z';

function event(payload: unknown, sessionId = 'kimi-thread-1'): KimiWsEvent {
  return { type: 'session_event', seq: 1, session_id: sessionId, payload };
}

const context: KimiEventContext = {
  resolveTurnId: (agentId, turnNumber) => (agentId === 'a1' ? `prompt-${turnNumber}` : null),
  isChildAgent: (agentId) => agentId === 'child-1',
};

describe('decodeKimiActivityFacts', () => {
  it('records a main turn start with the resolved prompt turn id', () => {
    const facts = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'turn.started', agentId: 'a1', turnId: 2 }),
      context,
    );
    expect(facts).toEqual([
      {
        sessionId: 's1',
        occurredAt: NOW,
        kind: 'turnStarted',
        threadId: 'kimi-thread-1',
        turnId: 'prompt-2',
      },
    ]);
  });

  it('marks child agent turns with a child thread id and no root turn', () => {
    const facts = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'turn.started', agentId: 'child-1', turnId: 5 }),
      context,
    );
    expect(facts).toEqual([
      {
        sessionId: 's1',
        occurredAt: NOW,
        kind: 'turnStarted',
        threadId: 'kimi-thread-1',
        childThreadId: 'child-1',
      },
    ]);
  });

  it('records prompt completion and abort as turn completion', () => {
    for (const type of ['prompt.completed', 'prompt.aborted']) {
      const facts = decodeKimiActivityFacts(
        's1',
        NOW,
        event({ type, agentId: 'a1', promptId: 'prompt-1' }),
        context,
      );
      expect(facts).toEqual([
        {
          sessionId: 's1',
          occurredAt: NOW,
          kind: 'turnCompleted',
          threadId: 'kimi-thread-1',
          turnId: 'prompt-1',
        },
      ]);
    }
  });

  it('decodes context usage fractions and percents', () => {
    const fraction = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'agent.status.updated', status: 'running', contextUsage: 0.42 }),
      context,
    );
    expect(fraction[0]).toMatchObject({ kind: 'contextUsage', contextUsedPercent: 42 });
    const percent = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'agent.status.updated', status: 'running', contextUsage: 87 }),
      context,
    );
    expect(percent[0]).toMatchObject({ kind: 'contextUsage', contextUsedPercent: 87 });
  });

  it('maps awaiting statuses to interaction-pending attention reasons', () => {
    const approval = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'agent.status.updated', status: 'awaiting_approval' }),
      context,
    );
    expect(approval[0]).toMatchObject({
      kind: 'interactionPending',
      attentionReason: 'permissionRequired',
    });
    const question = decodeKimiActivityFacts(
      's1',
      NOW,
      event({ type: 'agent.status.updated', status: 'awaiting_question' }),
      context,
    );
    expect(question[0]).toMatchObject({
      kind: 'interactionPending',
      attentionReason: 'materialAmbiguity',
    });
  });

  it('returns no facts for unrelated events', () => {
    expect(decodeKimiActivityFacts('s1', NOW, event({ type: 'assistant.delta' }), context)).toEqual(
      [],
    );
  });
});
