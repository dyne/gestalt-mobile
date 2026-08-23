/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { AutopilotController, type AutopilotClientState } from './autopilot-controller.js';

const snapshot = (state = 'monitoring') => ({
  state,
  // `enabled` mirrors the coordinator's requestedEnabled field, not a
  // presentation guess derived from the terminal state.
  enabled: !['disabled', 'attentionRequired', 'completed'].includes(state),
  retry: { position: 0, limit: 3 },
  updatedAt: '2026-08-20T00:00:00.000Z',
});
const attention = {
  requestId: 'attention-1',
  kind: 'orgPlanAttention',
  turnId: 'turn-1',
  requestedAt: '2026-08-20T00:00:00.000Z',
  payload: {
    reason: 'missingDependency',
    summary: 'A dependency is unavailable.',
    requestedAction: 'Restore the dependency.',
    resumeCondition: 'dependencyInstalled',
  },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
};

describe('AutopilotController', () => {
  it('converges bootstrap and sequenced replay for every open session', async () => {
    let published: ReturnType<typeof capture>;
    const controller = new AutopilotController(
      {
        getSession: async () => ({ autopilot: snapshot('disabled') }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([
      { id: 'a', autopilot: snapshot('disabled') },
      { id: 'b', autopilot: snapshot() },
    ]);
    controller.observe('a', { sequence: 2, type: 'autopilot.updated', payload: snapshot() });
    controller.observe('a', {
      sequence: 2,
      type: 'autopilot.updated',
      payload: snapshot('disabled'),
    });
    expect(published!.snapshots.get('a')?.state).toBe('monitoring');
    expect(published!.snapshots.get('b')?.state).toBe('monitoring');
  });

  it('keeps a stale toggle response out of a removed session', async () => {
    const request = deferred<{ autopilot: unknown }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: () => request.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const mutation = controller.toggle('a', true);
    controller.remove('a');
    request.resolve({ autopilot: snapshot() });
    await mutation;
    expect(published.snapshots.has('a')).toBe(false);
    expect(published.pending.has('a')).toBe(false);
  });

  it('lets the newest overlapping hydrate win, even when the older request resolves last', async () => {
    const first = deferred<{ autopilot: unknown; currentSequence: number }>();
    const second = deferred<{ autopilot: unknown; currentSequence: number }>();
    let reads = 0;
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: () => (reads++ === 0 ? first.promise : second.promise),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const initial = controller.hydrate('a');
    const newer = controller.hydrate('a');
    second.resolve({ autopilot: snapshot('backoff'), currentSequence: 4 });
    await newer;
    first.resolve({ autopilot: snapshot('monitoring'), currentSequence: 3 });
    await initial;
    await Promise.resolve();
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('does not let an unsequenced hydrate overwrite a toggle started after the read', async () => {
    const hydration = deferred<{ autopilot: unknown }>();
    const mutation = deferred<{ autopilot: unknown }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: () => hydration.promise,
        setAutopilot: () => mutation.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const read = controller.hydrate('a');
    const toggle = controller.toggle('a', true);
    hydration.resolve({ autopilot: snapshot('disabled') });
    mutation.resolve({ autopilot: snapshot('monitoring') });
    await Promise.all([read, toggle]);
    expect(published.snapshots.get('a')?.state).toBe('monitoring');
  });

  it('applies a newer sequenced list snapshot but rejects an older one', () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled'), currentSequence: 2 }]);
    controller.bootstrap([{ id: 'a', autopilot: snapshot('backoff'), currentSequence: 4 }]);
    controller.bootstrap([{ id: 'a', autopilot: snapshot('monitoring'), currentSequence: 3 }]);
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('tracks persistent attention and resolves it with an idempotency key', async () => {
    const calls: unknown[] = [];
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async (_id, _request, input) => calls.push(input),
      },
      (state) => (published = capture(state)),
      () => 'operation-key',
    );
    controller.bootstrap([{ id: 'a', pendingInteractions: [attention] }]);
    expect(published.attention.get('a')?.attention.reason).toBe('missingDependency');
    await controller.resolve('a', 'disableAutopilot');
    expect(calls).toEqual([{ operationKey: 'operation-key', action: 'disableAutopilot' }]);
  });

  it('retires a failed attention settlement while retaining the coordinator safety stop', () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', pendingInteractions: [attention] }]);
    controller.observe('a', {
      sequence: 1,
      type: 'org-plan.attention-resolved',
      payload: { requestId: attention.requestId, outcome: 'failed' },
    });
    expect(published.attention.has('a')).toBe(false);
  });

  it('keeps a failed settlement retired during the following empty shared snapshot', () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({ pendingInteractions: [], currentSequence: 2 }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', pendingInteractions: [attention], currentSequence: 1 }]);
    controller.observe('a', {
      sequence: 2,
      type: 'org-plan.attention-resolved',
      payload: { requestId: attention.requestId, outcome: 'failed' },
    });
    controller.applyAuthoritative('a', { pendingInteractions: [], currentSequence: 3 });
    expect(published.attention.has('a')).toBe(false);
  });

  it('fences both shared snapshots and hydrates sampled during a toggle mutation', async () => {
    const mutation = deferred<{ autopilot: unknown }>();
    const read = deferred<{ autopilot: unknown; currentSequence: number }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: () => read.promise,
        setAutopilot: () => mutation.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled'), currentSequence: 1 }]);
    const hydration = controller.hydrate('a');
    const toggle = controller.toggle('a', true);
    controller.applyAuthoritative('a', { autopilot: snapshot('disabled'), currentSequence: 9 });
    read.resolve({ autopilot: snapshot('disabled'), currentSequence: 8 });
    mutation.resolve({ autopilot: snapshot('monitoring') });
    await Promise.all([hydration, toggle]);
    expect(published.snapshots.get('a')?.state).toBe('monitoring');
  });

  it('rejects a late pre-mutation shared snapshot after a successful toggle until a newer sequence arrives', async () => {
    const mutation = deferred<{ autopilot: unknown }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: () => mutation.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled'), currentSequence: 7 }]);
    const toggle = controller.toggle('a', true);
    mutation.resolve({ autopilot: snapshot('monitoring') });
    await toggle;
    controller.applyAuthoritative('a', { autopilot: snapshot('disabled'), currentSequence: 7 });
    expect(published.snapshots.get('a')?.state).toBe('monitoring');
    controller.applyAuthoritative('a', { autopilot: snapshot('backoff'), currentSequence: 8 });
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('uses safe, actionable labels for typed autopilot conflicts', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => {
          throw Object.assign(new Error('raw server detail'), { code: 'AUTOPILOT_PLAN_REQUIRED' });
        },
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    await controller.toggle('a', true);
    expect(published.errors.get('a')).toBe(
      'An incomplete supervised plan is required before Autopilot can start.',
    );
  });

  it('accepts the exact server attention envelope and its resolved event form', () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('attentionRequired') }]);
    controller.observe('a', {
      sequence: 1,
      type: 'org-plan.attention-required',
      payload: attention,
    });
    expect(published.attention.get('a')).toMatchObject({
      requestId: 'attention-1',
      attention: { reason: 'missingDependency' },
    });
    controller.observe('a', {
      sequence: 2,
      type: 'org-plan.attention-resolved',
      payload: {
        requestId: 'attention-1',
        turnId: 'turn-1',
        resolvedAt: '2026-08-20T00:01:00.000Z',
        outcome: 'answered',
      },
    });
    expect(published.attention.has('a')).toBe(false);
  });

  it('does not let equal-cursor bootstrap, hydrate, or toggle responses replace newer authority', async () => {
    const response = deferred<{ autopilot: unknown; currentSequence: number }>();
    const mutation = deferred<{ autopilot: unknown }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: () => response.promise,
        setAutopilot: () => mutation.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled'), currentSequence: 1 }]);
    const hydrate = controller.hydrate('a');
    const toggle = controller.toggle('a', true);
    controller.observe('a', {
      sequence: 2,
      type: 'autopilot.updated',
      payload: snapshot('backoff'),
    });
    controller.bootstrap([{ id: 'a', autopilot: snapshot('monitoring'), currentSequence: 2 }]);
    response.resolve({ autopilot: snapshot('monitoring'), currentSequence: 2 });
    mutation.resolve({ autopilot: snapshot('monitoring') });
    await Promise.all([hydrate, toggle]);
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('serializes simultaneous controls from two surfaces into one idempotent operation', async () => {
    const request = deferred<{ autopilot: unknown }>();
    const keys: string[] = [];
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: (_id, _enabled, key) => {
          keys.push(key ?? '');
          return request.promise;
        },
        resolveAttention: async () => ({}),
      },
      () => {},
      () => 'one-operation',
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const chat = controller.toggle('a', true);
    const sessions = controller.toggle('a', true);
    request.resolve({ autopilot: snapshot('monitoring') });
    await Promise.all([chat, sessions]);
    expect(keys).toEqual(['one-operation']);
  });

  it('does not start a duplicate refresh for a sequence gap and preserves the socket update', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({ autopilot: snapshot('disabled') }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    controller.observe('a', { sequence: 3, type: 'autopilot.updated', payload: snapshot() });
    controller.observe('a', {
      sequence: 4,
      type: 'autopilot.updated',
      payload: snapshot('backoff'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('leaves gap recovery to AgentActivityController when no newer socket event arrives', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({ autopilot: snapshot('monitoring') }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    controller.observe('a', { sequence: 3, type: 'unrelated', payload: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(published.snapshots.get('a')?.state).toBe('disabled');
  });

  it('does not refresh after a remove and re-add gap', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({ autopilot: snapshot('monitoring') }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    controller.observe('a', { sequence: 3, type: 'unrelated', payload: {} });
    controller.remove('a');
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    controller.observe('a', { sequence: 3, type: 'unrelated', payload: {} });
    await Promise.resolve();
    expect(published.snapshots.get('a')?.state).toBe('disabled');
  });

  it('ignores a late toggle after a socket update', async () => {
    const request = deferred<{ autopilot: unknown }>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: () => request.promise,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const mutation = controller.toggle('a', true);
    controller.observe('a', {
      sequence: 1,
      type: 'autopilot.updated',
      payload: snapshot('backoff'),
    });
    request.resolve({ autopilot: snapshot('monitoring') });
    await mutation;
    expect(published.snapshots.get('a')?.state).toBe('backoff');
  });

  it('clears an active attention item when the authoritative disable response arrives', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot('disabled') }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([
      {
        id: 'a',
        autopilot: snapshot(),
        pendingInteractions: [attention],
      },
    ]);
    await controller.toggle('a', false);
    expect(published.snapshots.get('a')?.enabled).toBe(false);
    expect(published.attention.has('a')).toBe(false);
  });

  it('does not publish a late failed toggle after a newer socket update', async () => {
    let reject!: (error: Error) => void;
    const request = new Promise<{ autopilot: unknown }>((_, fail) => (reject = fail));
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: () => request,
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    const mutation = controller.toggle('a', true);
    controller.observe('a', {
      sequence: 1,
      type: 'autopilot.updated',
      payload: snapshot('backoff'),
    });
    reject(new Error('stale failure'));
    await mutation;
    expect(published.snapshots.get('a')?.state).toBe('backoff');
    expect(published.errors.has('a')).toBe(false);
  });

  it('does not duplicate overlapping gap reconciliation', async () => {
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({ autopilot: snapshot('monitoring') }),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: async () => ({}),
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', autopilot: snapshot('disabled') }]);
    controller.observe('a', { sequence: 3, type: 'unrelated', payload: {} });
    controller.observe('a', { sequence: 6, type: 'unrelated', payload: {} });
    await Promise.resolve();
    expect(published.snapshots.get('a')?.state).toBe('disabled');
  });

  it('rejects oversized guidance and prevents stale attention work after disposal', async () => {
    const request = deferred<unknown>();
    let published = capture();
    const controller = new AutopilotController(
      {
        getSession: async () => ({}),
        setAutopilot: async () => ({ autopilot: snapshot() }),
        resolveAttention: () => request.promise,
      },
      (state) => (published = capture(state)),
    );
    controller.bootstrap([{ id: 'a', pendingInteractions: [attention] }]);
    await controller.resolve('a', 'resume', 'x'.repeat(601));
    expect(published.errors.get('a')).toContain('600');
    const resolving = controller.resolve('a', 'resume', 'safe guidance');
    controller.dispose();
    request.resolve({});
    await resolving;
    expect(published.attention.size).toBe(0);
  });
});

function capture(
  state: AutopilotClientState = {
    snapshots: new Map(),
    attention: new Map(),
    pending: new Set(),
    errors: new Map(),
  },
) {
  return {
    snapshots: new Map(state.snapshots),
    attention: new Map(state.attention),
    pending: new Set(state.pending),
    errors: new Map(state.errors),
  };
}
