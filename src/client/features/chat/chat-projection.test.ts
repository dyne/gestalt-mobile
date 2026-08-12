/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import {
  acceptSnapshot,
  applyProjectionEvent,
  beginInteraction,
  beginSnapshot,
  createChatProjection,
  deriveStatus,
  failInteraction,
  failPrompt,
  hydrateCache,
  promotePrompt,
  queuePrompt,
  replayBuffered,
  resolveInteraction,
} from './chat-projection.js';

const snapshot = (baseSequence = 1) => ({
  baseSequence,
  currentSequence: baseSequence,
  activeTurnId: null,
  turns: [],
  items: [
    { id: 'u1', kind: 'user', text: 'hello' },
    { id: 'a1', kind: 'agent', text: 'world', phase: 'final_answer' },
  ],
  interactions: [
    {
      requestId: 'r1',
      kind: 'commandApproval',
      turnId: null,
      requestedAt: null,
      resolvedAt: null,
      payload: {},
    },
  ],
});
describe('chat projection', () => {
  it('merges snapshots without deleting optimistic prompts and preserves stable render keys', () => {
    const queued = queuePrompt(createChatProjection('s'), 'op', 'pending');
    const next = acceptSnapshot(queued, snapshot());
    expect(next.messages.map((item) => item.id)).toEqual(['item:u1', 'item:a1', 'prompt:op']);
    expect(next.prompts[0]?.state).toBe('submitting');
  });
  it('keeps optimistic prompts and live agent items at their turn positions during history reconciliation', () => {
    const first = acceptSnapshot(createChatProjection('s'), {
      ...snapshot(),
      items: [
        { id: 'user-1', kind: 'user', text: 'first', turnId: 'turn-1' },
        {
          id: 'answer-1',
          kind: 'agent',
          text: 'first answer',
          phase: 'final_answer',
          turnId: 'turn-1',
        },
      ],
    });
    const queued = promotePrompt(
      queuePrompt(first, 'operation-2', 'second'),
      'operation-2',
      'turn-2',
    );
    const live = applyProjectionEvent(queued, {
      sequence: 2,
      type: 'agentMessageDelta',
      payload: {
        itemId: 'live-2',
        text: 'second commentary',
        phase: 'commentary',
        turnId: 'turn-2',
      },
    });

    const reconciled = acceptSnapshot(live, {
      ...snapshot(2),
      activeTurnId: 'turn-2',
      items: [
        { id: 'user-1', kind: 'user', text: 'first', turnId: 'turn-1' },
        {
          id: 'answer-1',
          kind: 'agent',
          text: 'first answer',
          phase: 'final_answer',
          turnId: 'turn-1',
        },
        {
          id: 'user-2',
          kind: 'user',
          text: 'second',
          operationId: 'operation-2',
          turnId: 'turn-2',
        },
      ],
    });

    expect(reconciled.messages.map((message) => message.id)).toEqual([
      'item:user-1',
      'item:answer-1',
      'prompt:operation-2',
      'assistant:live-2',
    ]);
  });
  it('replaces a live item with its canonical item once without moving adjacent turns', () => {
    const projection = applyProjectionEvent(
      promotePrompt(queuePrompt(createChatProjection('s'), 'op', 'second'), 'op', 'turn-2'),
      {
        sequence: 1,
        type: 'agentMessageCompleted',
        payload: {
          itemId: 'answer-2',
          text: 'second answer',
          phase: 'final_answer',
          turnId: 'turn-2',
        },
      },
    );
    const reconciled = acceptSnapshot(projection, {
      ...snapshot(),
      items: [
        { id: 'user-1', kind: 'user', text: 'first', turnId: 'turn-1' },
        {
          id: 'answer-1',
          kind: 'agent',
          text: 'first answer',
          phase: 'final_answer',
          turnId: 'turn-1',
        },
        { id: 'user-2', kind: 'user', text: 'second', operationId: 'op', turnId: 'turn-2' },
        {
          id: 'answer-2',
          kind: 'agent',
          text: 'second answer',
          phase: 'final_answer',
          turnId: 'turn-2',
        },
      ],
    });

    expect(reconciled.messages.map((message) => message.id)).toEqual([
      'item:user-1',
      'item:answer-1',
      'prompt:op',
      'assistant:answer-2',
    ]);
    expect(reconciled.messages.filter((message) => message.text === 'second answer')).toHaveLength(
      1,
    );
  });
  it('keeps first event times until canonical history supplies its authoritative occurrence time', () => {
    const queued = promotePrompt(
      queuePrompt(createChatProjection('s'), 'op', 'prompt', 1_000),
      'op',
      'turn-1',
    );
    const started = applyProjectionEvent(queued, {
      sequence: 1,
      type: 'agentMessageStarted',
      occurredAt: '2026-08-12T10:00:01.000Z',
      payload: { itemId: 'answer', text: '', phase: 'commentary', turnId: 'turn-1' },
    });
    const completed = applyProjectionEvent(started, {
      sequence: 2,
      type: 'agentMessageCompleted',
      occurredAt: '2026-08-12T10:00:09.000Z',
      payload: { itemId: 'answer', text: 'Done.', phase: 'final_answer', turnId: 'turn-1' },
    });
    expect(completed.messages.map((message) => message.occurredAt)).toEqual([
      1_000,
      Date.parse('2026-08-12T10:00:01.000Z'),
    ]);

    const canonical = acceptSnapshot(completed, {
      ...snapshot(2),
      turns: [{ id: 'turn-1', items: [], startedAt: 2_000, completedAt: 3_000 }],
      items: [
        {
          id: 'user',
          kind: 'user',
          text: 'prompt',
          operationId: 'op',
          turnId: 'turn-1',
          occurredAt: 2_500,
        },
        {
          id: 'answer',
          kind: 'agent',
          text: 'Done.',
          phase: 'final_answer',
          turnId: 'turn-1',
          occurredAt: 3_500,
        },
      ],
    });
    expect(canonical.messages.map((message) => message.occurredAt)).toEqual([2_500, 3_500]);
  });
  it('attributes relay event times to interactions and activities without accepting invalid timestamps', () => {
    const requested = applyProjectionEvent(createChatProjection('s'), {
      sequence: 1,
      type: 'interaction.requested',
      occurredAt: '2026-08-12T10:00:01.000Z',
      payload: { requestId: 'request', kind: 'commandApproval', turnId: 'turn', payload: {} },
    });
    const updated = applyProjectionEvent(requested, {
      sequence: 2,
      type: 'activity.updated',
      occurredAt: 'not-a-date',
      payload: { id: 'activity', label: 'Command', detail: 'npm test', turnId: 'turn' },
    });
    const timed = applyProjectionEvent(updated, {
      sequence: 3,
      type: 'activity.updated',
      occurredAt: '2026-08-12T10:00:03.000Z',
      payload: { id: 'activity-2', label: 'Tool', detail: 'check', turnId: 'turn' },
    });
    expect(timed.interactions[0]?.occurredAt).toBe(Date.parse('2026-08-12T10:00:01.000Z'));
    expect(timed.activities).toEqual([
      { id: 'activity', label: 'Command', detail: 'npm test', turnId: 'turn' },
      {
        id: 'activity-2',
        label: 'Tool',
        detail: 'check',
        turnId: 'turn',
        occurredAt: Date.parse('2026-08-12T10:00:03.000Z'),
      },
    ]);
  });
  it('hydrates valid cached occurrence times and rejects non-finite values', () => {
    const valid = hydrateCache('s', {
      cursor: 1,
      messages: [{ id: 'u', role: 'user', text: 'prompt', occurredAt: 1_000 }],
      prompts: [
        {
          operationId: 'op',
          key: 'prompt:op',
          text: 'prompt',
          state: 'accepted',
          occurredAt: 1_000,
        },
      ],
      interactions: [
        {
          requestId: 'request',
          key: 'interaction:request',
          kind: 'quiz',
          state: 'pending',
          occurredAt: 2_000,
        },
      ],
    });
    expect(valid.messages[0]?.occurredAt).toBe(1_000);
    expect(valid.prompts[0]?.occurredAt).toBe(1_000);
    expect(valid.interactions[0]?.occurredAt).toBe(2_000);
    expect(
      hydrateCache('s', {
        cursor: 1,
        messages: [{ id: 'u', role: 'user', text: 'prompt', occurredAt: Number.NaN }],
        prompts: [],
        interactions: [],
      }).messages,
    ).toEqual([]);
  });
  it('is deterministic for duplicate and overlap schedules', () => {
    const event = { sequence: 2, type: 'agentMessageDelta', payload: { text: '!' } };
    const first = applyProjectionEvent(
      acceptSnapshot(createChatProjection('s'), snapshot()),
      event,
    );
    const overlap = replayBuffered(
      applyProjectionEvent(
        applyProjectionEvent(acceptSnapshot(createChatProjection('s'), snapshot()), event),
        event,
      ),
    );
    expect(first).toEqual(overlap);
    expect(new Set(first.messages.map((item) => item.id)).size).toBe(first.messages.length);
  });
  it('buffers gaps, rejects malformed sequence input, and replays in order', () => {
    const base = acceptSnapshot(createChatProjection('s'), snapshot());
    const gap = applyProjectionEvent(base, {
      sequence: 3,
      type: 'agentMessageDelta',
      payload: { text: 'later' },
    });
    expect(gap.snapshotting).toBe(true);
    expect(
      applyProjectionEvent(base, { sequence: Number.NaN, type: 'agentMessageDelta', payload: {} }),
    ).toBe(base);
    const replayed = replayBuffered(
      applyProjectionEvent(
        { ...gap, snapshotting: false },
        { sequence: 2, type: 'agentMessageDelta', payload: { text: 'now' } },
      ),
    );
    expect(replayed.cursor).toBe(3);
  });
  it('does not skip eligible events from a currentSequence compatibility field', () => {
    const base = acceptSnapshot(createChatProjection('s'), { ...snapshot(), currentSequence: 99 });
    expect(
      applyProjectionEvent(base, {
        sequence: 2,
        type: 'agentMessageDelta',
        payload: { text: 'still eligible' },
      }).cursor,
    ).toBe(2);
  });
  it('does not let a stale snapshot cut roll back sequenced timeline state', () => {
    const base = acceptSnapshot(createChatProjection('s'), {
      ...snapshot(2),
      activeTurnId: 'turn-1',
      items: [],
      interactions: [],
    });
    const final = applyProjectionEvent(base, {
      sequence: 3,
      type: 'agentMessageDelta',
      payload: { text: 'recovered final', phase: 'final_answer' },
    });
    const interaction = applyProjectionEvent(final, {
      sequence: 4,
      type: 'interaction.requested',
      payload: { requestId: 'request-1', kind: 'commandApproval', turnId: 'turn-1', payload: {} },
    });
    const activity = applyProjectionEvent(interaction, {
      sequence: 5,
      type: 'activity.updated',
      payload: { id: 'activity-1', label: 'Tool', detail: 'Finished' },
    });

    const retained = acceptSnapshot(beginSnapshot(activity), {
      ...snapshot(2),
      activeTurnId: null,
      items: [],
      interactions: [],
    });

    expect(retained).toMatchObject({
      cursor: 5,
      snapshotting: false,
      activeTurnId: 'turn-1',
      lifecycle: 'working',
    });
    expect(retained.messages).toEqual([
      expect.objectContaining({ text: 'recovered final', phase: 'final_answer', complete: true }),
    ]);
    expect(retained.interactions).toEqual([
      expect.objectContaining({ requestId: 'request-1', state: 'pending' }),
    ]);
    expect(retained.activities).toEqual([
      { id: 'activity-1', label: 'Tool', detail: 'Finished', turnId: 'turn-1' },
    ]);
  });
  it('does not promote duplicate identical optimistic prompts by ambiguous text', () => {
    const projection = queuePrompt(
      queuePrompt(createChatProjection('s'), 'one', 'same'),
      'two',
      'same',
    );
    const next = acceptSnapshot(projection, {
      ...snapshot(),
      items: [{ id: 'u', kind: 'user', text: 'same' }],
    });
    expect(next.prompts.map((prompt) => prompt.state)).toEqual(['submitting', 'submitting']);
    expect(promotePrompt(next, 'one', 'turn').prompts[0]?.turnId).toBe('turn');
  });
  it('promotes a canonical user item with a different upstream id into the exact optimistic render record', () => {
    const accepted = promotePrompt(
      queuePrompt(createChatProjection('s'), 'op', 'same'),
      'op',
      'turn-1',
    );
    const optimistic = accepted.messages[0];
    const promoted = acceptSnapshot(accepted, {
      ...snapshot(),
      items: [{ id: 'upstream-different', kind: 'user', text: 'same', turnId: 'turn-1' }],
    });
    expect(promoted.messages).toEqual([optimistic]);
    expect(promoted.messages[0]).toBe(optimistic);
    expect(promoted.messages[0]?.id).toBe('prompt:op');
  });
  it('keeps a turn-owned live assistant key through commentary/final snapshot overlap', () => {
    const working = promotePrompt(queuePrompt(createChatProjection('s'), 'op', 'p'), 'op', 'turn');
    const live = applyProjectionEvent(working, {
      sequence: 1,
      type: 'agentMessageDelta',
      payload: { text: 'answer' },
    });
    const snapshotFinal = acceptSnapshot(live, {
      ...snapshot(),
      baseSequence: 1,
      activeTurnId: 'turn',
      items: [
        {
          id: 'server-message',
          kind: 'agent',
          text: 'answer',
          phase: 'final_answer',
          turnId: 'turn',
        },
      ],
    });
    expect(snapshotFinal.messages.filter((message) => message.role === 'assistant')).toHaveLength(
      1,
    );
    expect(snapshotFinal.messages.find((message) => message.role === 'assistant')).toMatchObject({
      id: 'assistant:turn',
      text: 'answer',
      phase: 'final_answer',
    });
  });
  it('hydrates only valid bounded cache shapes', () => {
    expect(
      hydrateCache('s', { cursor: 2, messages: [], prompts: [], interactions: [] }).cursor,
    ).toBe(2);
    expect(hydrateCache('s', { cursor: -1, messages: [] }).cursor).toBe(0);
    const oversized = hydrateCache('s', {
      cursor: 1,
      messages: Array.from({ length: 201 }, (_, id) => ({
        id: String(id),
        role: 'user',
        text: 'x',
      })),
      prompts: [{ operationId: 'bad', key: 'bad', text: 'x', state: 'nope' }],
      interactions: [{ requestId: 'bad', key: 'bad', kind: 'x', state: 'nope' }],
    });
    expect(oversized.messages).toHaveLength(200);
    expect(oversized.prompts).toHaveLength(0);
    expect(oversized.interactions).toHaveLength(0);
  });
  it('retains a gap until a snapshot cut establishes contiguity', () => {
    const gap = applyProjectionEvent(acceptSnapshot(createChatProjection('s'), snapshot()), {
      sequence: 3,
      type: 'agentMessageDelta',
      payload: { text: 'later' },
    });
    expect(replayBuffered(gap).snapshotting).toBe(true);
  });
  it('covers prompt and interaction legal transition table', () => {
    const initial = acceptSnapshot(
      queuePrompt(createChatProjection('s'), 'op', 'prompt'),
      snapshot(),
    );
    expect(failPrompt(initial, 'op').prompts[0]?.state).toBe('failed');
    const pending = initial.interactions[0]!;
    expect(beginInteraction(initial, pending.requestId).interactions[0]?.state).toBe('submitting');
    expect(
      failInteraction(beginInteraction(initial, pending.requestId), pending.requestId, {
        decision: 'accept',
      }).interactions[0]?.state,
    ).toBe('failed');
    expect(resolveInteraction(initial, pending.requestId).interactions[0]?.state).toBe('resolved');
  });
  it('handles commentary/final empty content and finish/interrupt races monotonically', () => {
    const base = acceptSnapshot(createChatProjection('s'), {
      ...snapshot(),
      activeTurnId: 't',
      items: [],
    });
    const final = applyProjectionEvent(base, {
      sequence: 2,
      type: 'agentMessageCompleted',
      payload: { text: '', phase: 'final_answer' },
    });
    const finished = applyProjectionEvent(final, {
      sequence: 3,
      type: 'turnCompleted',
      payload: {},
    });
    expect(
      applyProjectionEvent(finished, { sequence: 4, type: 'turnInterrupted', payload: {} })
        .lifecycle,
    ).toBe('finished');
    expect(final.messages[0]).toMatchObject({ phase: 'final_answer', text: '' });
  });
  it('keeps a requested interaction attached to the active turn for timeline rendering', () => {
    const requested = applyProjectionEvent(
      {
        ...acceptSnapshot(createChatProjection('s'), { ...snapshot(), activeTurnId: 'turn-1' }),
        cursor: 1,
      },
      {
        sequence: 2,
        type: 'interaction.requested',
        payload: { requestId: 'request-1', kind: 'commandApproval' },
      },
    );
    expect(requested.interactions[1]).toMatchObject({ requestId: 'request-1', turnId: 'turn-1' });
  });
  it('keeps finished lifecycle through a stale active snapshot and converges finish/interrupt permutations', () => {
    const base = acceptSnapshot(createChatProjection('s'), {
      ...snapshot(),
      activeTurnId: 'old',
      items: [],
    });
    const events = [
      { sequence: 2, type: 'turnCompleted', payload: {} },
      { sequence: 3, type: 'turnInterrupted', payload: {} },
    ];
    const left = events.reduce(applyProjectionEvent, base);
    const right = events
      .slice()
      .reverse()
      .reduce(
        (state, event) =>
          applyProjectionEvent(state, { ...event, sequence: event.sequence === 2 ? 3 : 2 }),
        base,
      );
    expect(
      acceptSnapshot(left, { ...snapshot(), baseSequence: 3, activeTurnId: 'old', items: [] })
        .lifecycle,
    ).toBe('finished');
    expect(deriveStatus(left)).toBe(deriveStatus(right));
    expect(left.lifecycle).toBe(right.lifecycle);
  });
  it('derives working for an initial active snapshot but keeps a sequenced finish monotonic', () => {
    const initial = acceptSnapshot(createChatProjection('s'), {
      ...snapshot(),
      activeTurnId: 'turn',
      items: [],
    });
    expect(deriveStatus(initial)).toBe('Codex is working…');
    const finished = applyProjectionEvent(initial, {
      sequence: 2,
      type: 'turnCompleted',
      payload: {},
    });
    expect(
      acceptSnapshot(finished, { ...snapshot(2), activeTurnId: 'turn', items: [] }).lifecycle,
    ).toBe('finished');
  });
  it('upserts duplicate activity updates inside the projection', () => {
    const one = applyProjectionEvent(createChatProjection('s'), {
      sequence: 1,
      type: 'activity.updated',
      payload: { id: 'a', label: 'first', detail: 'x' },
    });
    const two = applyProjectionEvent(one, {
      sequence: 2,
      type: 'activity.updated',
      payload: { id: 'a', label: 'second', detail: 'y' },
    });
    expect(two.activities).toEqual([{ id: 'a', label: 'second', detail: 'y' }]);
  });
  it('keeps separate agent items live and promotes their phases without waiting for history', () => {
    const working = promotePrompt(
      queuePrompt(createChatProjection('s'), 'op', 'prompt'),
      'op',
      'turn-1',
    );
    const commentary = applyProjectionEvent(working, {
      sequence: 1,
      type: 'agentMessageStarted',
      payload: { itemId: 'commentary-1', text: '', phase: 'commentary', turnId: 'turn-1' },
    });
    const commentaryDelta = applyProjectionEvent(commentary, {
      sequence: 2,
      type: 'agentMessageDelta',
      payload: { itemId: 'commentary-1', text: 'Checking.', turnId: 'turn-1' },
    });
    const answer = applyProjectionEvent(commentaryDelta, {
      sequence: 3,
      type: 'agentMessageCompleted',
      payload: {
        itemId: 'answer-1',
        text: 'Done.',
        phase: 'final_answer',
        turnId: 'turn-1',
      },
    });

    expect(answer.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'assistant:commentary-1',
        phase: 'commentary',
        text: 'Checking.',
      }),
      expect.objectContaining({
        id: 'assistant:answer-1',
        phase: 'final_answer',
        text: 'Done.',
        complete: true,
      }),
    ]);
  });
  it('keeps interaction resolutions monotonic and derives lifecycle status', () => {
    const projection = resolveInteraction(
      acceptSnapshot(createChatProjection('s'), snapshot()),
      'r1',
      { decision: 'accept' },
    );
    expect(acceptSnapshot(projection, snapshot()).interactions[0]?.state).toBe('resolved');
    expect(
      deriveStatus(
        applyProjectionEvent(projection, { sequence: 2, type: 'turnCompleted', payload: {} }),
      ),
    ).toBe('Ready.');
  });
});
