/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { normalizeKimiEvent } from './kimi-normalizer.js';
import type { KimiEventContext } from './kimi-normalizer.js';
import type { KimiWsEvent } from './kimi-ws-client.js';

const NOW = '2026-09-22T00:00:00.000Z';

function event(payload: unknown, sessionId = 'kimi-thread-1'): KimiWsEvent {
  return { type: 'session_event', seq: 7, session_id: sessionId, payload };
}

const context: KimiEventContext = {
  workspacePath: '/repo',
  activeTurnId: 'prompt-1',
  resolveTurnId: (agentId, turnNumber) => (agentId === 'a1' ? `prompt-${turnNumber}` : null),
  isChildAgent: (agentId) => agentId === 'child-1',
};

describe('normalizeKimiEvent', () => {
  it('maps a main-agent delta to an agentMessageDelta on the resolved turn', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'assistant.delta', agentId: 'a1', turnId: 2, delta: 'hello' }),
      context,
    );
    expect(normalized).toEqual({
      sessionId: 's1',
      sequence: 0,
      occurredAt: NOW,
      type: 'agentMessageDelta',
      payload: { text: 'hello', itemId: 'kimi:a1:2', turnId: 'prompt-2' },
    });
  });

  it('falls back to a synthetic turn id when the agent turn is unbound', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'assistant.delta', agentId: 'a9', turnId: 3, delta: 'x' }),
      context,
    );
    expect(normalized && (normalized.payload as { turnId: string }).turnId).toBe('kimi:a9:3');
  });

  it('drops child-agent deltas', () => {
    expect(
      normalizeKimiEvent(
        's1',
        0,
        NOW,
        event({ type: 'assistant.delta', agentId: 'child-1', turnId: 1, delta: 'x' }),
        context,
      ),
    ).toBeNull();
  });

  it('maps tool.call.started command display to a Command activity on the turn', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({
        type: 'tool.call.started',
        agentId: 'a1',
        turnId: 1,
        toolCallId: 'tc1',
        name: 'run',
        display: { kind: 'bash', command: 'npm test' },
      }),
      context,
    );
    expect(normalized?.type).toBe('activity.updated');
    expect(normalized?.payload).toEqual({
      id: 'tc1',
      label: 'Command',
      detail: 'npm test',
      turnId: 'prompt-1',
    });
  });

  it('attributes child-agent tool activity to the active turn with an actor id', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({
        type: 'tool.call.started',
        agentId: 'child-1',
        turnId: 4,
        toolCallId: 'tc9',
        display: { kind: 'file_io', path: '/repo/a.ts' },
      }),
      context,
    );
    expect(normalized?.payload).toEqual({
      id: 'tc9',
      label: 'File',
      detail: '/repo/a.ts',
      turnId: 'prompt-1',
      actorTurnId: 'child-1:4',
    });
  });

  it('maps tool.result errors with bounded output', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({
        type: 'tool.result',
        agentId: 'a1',
        turnId: 1,
        toolCallId: 'tc1',
        isError: true,
        output: { exitCode: 1 },
      }),
      context,
    );
    expect(normalized?.payload).toMatchObject({ id: 'tc1', label: 'Tool error' });
  });

  it('maps subagent lifecycle events to activities on the active turn', () => {
    const spawned = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'subagent.spawned', subagentId: 'sub-1', subagentName: 'explorer' }),
      context,
    );
    expect(spawned?.payload).toEqual({
      id: 'sub-1',
      label: 'Subagent',
      detail: 'explorer',
      turnId: 'prompt-1',
    });
    const failed = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'subagent.failed', subagentId: 'sub-1' }),
      context,
    );
    expect(failed?.payload).toMatchObject({ id: 'sub-1', label: 'Subagent failed' });
  });

  it('maps prompt.completed to turnCompleted with the prompt id', () => {
    const normalized = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'prompt.completed', agentId: 'a1', promptId: 'prompt-1', reason: 'completed' }),
      context,
    );
    expect(normalized).toEqual({
      sessionId: 's1',
      sequence: 0,
      occurredAt: NOW,
      type: 'turnCompleted',
      payload: { turn: { id: 'prompt-1', status: 'completed' } },
    });
  });

  it('maps prompt.aborted to turnInterrupted and drops child prompts', () => {
    const aborted = normalizeKimiEvent(
      's1',
      0,
      NOW,
      event({ type: 'prompt.aborted', agentId: 'a1', promptId: 'prompt-1' }),
      context,
    );
    expect(aborted?.type).toBe('turnInterrupted');
    expect(
      normalizeKimiEvent(
        's1',
        0,
        NOW,
        event({ type: 'prompt.aborted', agentId: 'child-1', promptId: 'p' }),
        context,
      ),
    ).toBeNull();
  });

  it('returns null for unknown or malformed events', () => {
    expect(normalizeKimiEvent('s1', 0, NOW, event({ type: 'mystery' }), context)).toBeNull();
    expect(normalizeKimiEvent('s1', 0, NOW, event(null), context)).toBeNull();
    expect(normalizeKimiEvent('s1', 0, NOW, { type: 'session_event' }, context)).toBeNull();
  });
});
