/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import {
  createAgentActivitySnapshot,
  projectAgentActivity,
  withActivityConfidence,
} from './model.js';
const at = '2026-01-01T00:00:00.000Z';
const fact = (kind: Parameters<typeof projectAgentActivity>[1]['kind'], more = {}) => ({
  sessionId: 's',
  occurredAt: at,
  kind,
  ...more,
});
describe('agent activity projector', () => {
  it('gives pending interaction precedence over an active turn', () => {
    const active = projectAgentActivity(createAgentActivitySnapshot('s', at), fact('turnStarted'));
    expect(projectAgentActivity(active, fact('interactionPending')).root).toMatchObject({
      state: 'awaitingHuman',
      reason: 'pendingInteraction',
    });
  });

  it('keeps a typed attention blocker authoritative while an unrelated interaction resolves', () => {
    const pending = projectAgentActivity(createAgentActivitySnapshot('s', '2026-01-01T00:00:00Z'), {
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:01Z',
      kind: 'interactionPending',
      attentionReason: 'hardBlock',
    });
    const unrelatedResolved = projectAgentActivity(pending, {
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:02Z',
      kind: 'interactionResolved',
      hasPendingInteraction: true,
      attentionReason: 'hardBlock',
    });
    expect(unrelatedResolved.root).toMatchObject({ state: 'awaitingHuman', reason: 'hardBlock' });
    expect(
      projectAgentActivity(unrelatedResolved, {
        sessionId: 's',
        occurredAt: '2026-01-01T00:00:03Z',
        kind: 'interactionResolved',
        hasPendingInteraction: false,
      }).root,
    ).toMatchObject({ state: 'working', reason: 'turnActive' });
  });
  it('keeps child activity independent while the root waits', () => {
    let child = projectAgentActivity(createAgentActivitySnapshot('s', at), fact('turnStarted'));
    child = projectAgentActivity(
      child,
      fact('collaboration', {
        childId: 'c',
        childStatus: 'working',
        collaborationAction: 'spawn_agent',
      }),
    );
    child = projectAgentActivity(
      child,
      fact('collaboration', { childId: 'c', collaborationAction: 'wait' }),
    );
    expect(child).toMatchObject({
      root: { state: 'awaitingAgent' },
      aggregateSubagents: 'working',
      subagents: [{ id: 'c', state: 'working' }],
    });
  });
  it('retains the spawned child model across later status updates', () => {
    const spawned = projectAgentActivity(
      createAgentActivitySnapshot('s', at),
      fact('collaboration', {
        childId: 'c',
        childModel: 'gpt-5.6-luna',
        childStatus: 'working',
        collaborationAction: 'spawn_agent',
      }),
    );
    const completed = projectAgentActivity(
      spawned,
      fact('collaboration', { childId: 'c', childStatus: 'completed' }),
    );
    expect(completed.subagents).toMatchObject([{ id: 'c', model: 'gpt-5.6-luna' }]);
  });
  it('adds a model when reconciliation discovered the child before spawn metadata', () => {
    const discovered = projectAgentActivity(
      createAgentActivitySnapshot('s', at),
      fact('collaboration', {
        childId: 'c',
        childStatus: 'working',
      }),
    );
    const enriched = projectAgentActivity(
      discovered,
      fact('collaboration', {
        childId: 'c',
        childModel: 'gpt-5.6-luna',
        childStatus: 'working',
      }),
    );
    expect(enriched).not.toBe(discovered);
    expect(enriched.subagents).toMatchObject([{ id: 'c', model: 'gpt-5.6-luna' }]);
  });
  it('is duplicate and session isolated', () => {
    const first = projectAgentActivity(createAgentActivitySnapshot('s', at), fact('turnStarted'));
    expect(projectAgentActivity(first, fact('turnStarted'))).toBe(first);
    expect(projectAgentActivity(first, { ...fact('turnCompleted'), sessionId: 'other' })).toBe(
      first,
    );
  });
  it('does not make an explicitly active root idle from observed activity', () => {
    const active = projectAgentActivity(createAgentActivitySnapshot('s', at), fact('turnStarted'));
    expect(projectAgentActivity(active, fact('observed')).root.state).toBe('working');
  });
  it('does not regress a newer active turn from an older completion', () => {
    const active = projectAgentActivity(
      createAgentActivitySnapshot('s', at),
      fact('turnStarted', { occurredAt: '2026-01-01T00:01:00.000Z' }),
    );
    expect(projectAgentActivity(active, fact('turnCompleted')).root.state).toBe('working');
  });
  it('does not let a child-thread status mutate the root', () => {
    let snapshot = projectAgentActivity(
      createAgentActivitySnapshot('s', at),
      fact('threadStarted', { threadId: 'root', status: 'active' }),
    );
    snapshot = projectAgentActivity(
      snapshot,
      fact('collaboration', {
        childId: 'child',
        childThreadId: 'child-thread',
        childStatus: 'working',
      }),
    );
    const next = projectAgentActivity(
      snapshot,
      fact('threadStatus', { threadId: 'child-thread', status: 'idle' }),
    );
    expect(next.root.state).toBe('working');
    expect(next.subagents[0]).toMatchObject({ id: 'child', state: 'idle' });
  });
  it('aggregates blocked children before working and supports confidence qualification', () => {
    let snapshot = createAgentActivitySnapshot('s', at);
    snapshot = projectAgentActivity(
      snapshot,
      fact('collaboration', { childId: 'one', childStatus: 'working' }),
    );
    snapshot = projectAgentActivity(
      snapshot,
      fact('collaboration', { childId: 'two', childStatus: 'failed' }),
    );
    expect(withActivityConfidence(snapshot, 'reconciling')).toMatchObject({
      aggregateSubagents: 'blocked',
      confidence: 'reconciling',
    });
  });
  it('settles a current-protocol executor after its final review report', () => {
    let snapshot = projectAgentActivity(createAgentActivitySnapshot('s', at), fact('turnStarted'));
    snapshot = projectAgentActivity(
      snapshot,
      fact('collaboration', {
        childId: 'executor',
        childStatus: 'running',
        collaborationAction: 'spawn_agent',
      }),
    );
    snapshot = projectAgentActivity(
      snapshot,
      fact('collaboration', {
        childId: 'executor',
        childStatus: 'completed',
        collaborationAction: 'wait',
      }),
    );
    expect(snapshot).toMatchObject({
      root: { state: 'awaitingAgent' },
      aggregateSubagents: 'idle',
      subagents: [{ id: 'executor', state: 'idle', reason: 'collaborationWait' }],
    });
  });
});
