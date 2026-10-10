/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import lifecycle from './live-lifecycle.json';
import { OwnershipContract, resumeAvailable, type Run } from './live-ownership.js';

const fixtures: Array<{ root: string; stores: OwnershipContract[] }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-contract-'));
  const path = join(root, 'live.sqlite');
  const stores = [new OwnershipContract(path), new OwnershipContract(path)];
  fixtures.push({ root, stores });
  return stores as [OwnershipContract, OwnershipContract];
}
afterEach(() => {
  for (const { root, stores } of fixtures.splice(0)) {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function inState(store: OwnershipContract, state: string): Run {
  let run = store.start('run', 'relay', '/app');
  if (state === 'starting') return run;
  if (state === 'active') return store.transition(run, 'ready');
  if (state === 'stopping' || state === 'idle') {
    run = store.transition(run, 'stop');
    return state === 'idle' ? store.transition(run, 'cleaned') : run;
  }
  return store.transition(run, state === 'error' ? 'fail' : 'restart');
}

describe('normative Live transition and atomic ownership contract', () => {
  const forbidden = lifecycle.states.flatMap((from) =>
    [...new Set(lifecycle.transitions.map((entry) => entry.event))]
      .filter(
        (event) =>
          !lifecycle.transitions.some((entry) => entry.from === from && entry.event === event),
      )
      .map((event) => ({ from, event })),
  );
  it.each(forbidden)('forbids $from + $event without releasing ownership', ({ from, event }) => {
    const [store] = fixture();
    const run = inState(store, from);
    expect(() => store.transition(run, event)).toThrow('LIVE_STATE_CONFLICT');
    expect(store.find(run.liveId)).toEqual(run);
  });

  it.each(lifecycle.transitions.filter((entry) => entry.event !== 'start'))(
    '$from + $event -> $to',
    ({ from, event, to }) => {
      const [store] = fixture();
      const run = inState(store, from);
      const next = store.transition(run, event);
      expect(next.state).toBe(to);
      expect(next.revision).toBe(run.revision + 1);
      if (event === 'restart' || event === 'reconciledResume')
        expect(next.generation).toBeGreaterThan(run.generation);
    },
  );

  it.each(lifecycle.states.filter((state) => state !== 'idle'))(
    '%s retains both claims and blocks ordinary dispatch',
    (state) => {
      const [store, other] = fixture();
      inState(store, state);
      expect(() => other.start('other', 'other-relay', '/app')).toThrow('LIVE_APP_BUSY');
      expect(() => other.start('other', 'relay', '/other')).toThrow('LIVE_MODE_ACTIVE');
      expect(() => other.reserveDispatch('other-relay', '/app')).toThrow('LIVE_MODE_ACTIVE');
      expect(() => other.reserveDispatch('relay', '/other')).toThrow('LIVE_MODE_ACTIVE');
    },
  );

  it('does not leave a partial relay claim when the app claim loses', () => {
    const [first, second] = fixture();
    first.start('first', 'relay-a', '/app');
    expect(() => second.start('loser', 'relay-b', '/app')).toThrow('LIVE_APP_BUSY');
    expect(second.find('loser')).toBeUndefined();
    expect(second.start('unrelated', 'relay-b', '/other').state).toBe('starting');
  });

  it('the database itself forbids duplicate app and relay claims from another connection', () => {
    const [first, second] = fixture();
    first.start('first', 'relay-a', '/app');
    const insert = second.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)');
    expect(() => insert.run('app-conflict', 'relay-b', '/app', 'starting', 2, 1)).toThrow();
    expect(() => insert.run('relay-conflict', 'relay-a', '/other', 'starting', 3, 1)).toThrow();
    expect(second.find('app-conflict')).toBeUndefined();
    expect(second.find('relay-conflict')).toBeUndefined();
  });

  it('a newly opened controller sees durable claims and must reconcile instead of starting', () => {
    const [first] = fixture();
    const old = inState(first, 'active');
    const ownedFixture = fixtures.at(-1)!;
    const recovered = new OwnershipContract(join(ownedFixture.root, 'live.sqlite'));
    ownedFixture.stores.push(recovered);
    expect(() => recovered.start('new', 'relay-b', '/app')).toThrow('LIVE_APP_BUSY');
    const fenced = recovered.transition(old, 'restart');
    expect(fenced.state).toBe('recoveryRequired');
    expect(() => first.transition(old, 'stop')).toThrow('LIVE_GENERATION_STALE');
  });

  it.each(['a', 'b'])('two racing starts have one winner when %s arrives first', async (winner) => {
    const [a, b] = fixture();
    const operations = [
      () => a.start('a', 'relay-a', '/app'),
      () => b.start('b', 'relay-b', '/app'),
    ];
    if (winner === 'b') operations.reverse();
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(a.find(winner)?.state).toBe('starting');
  });

  it.each(['start', 'dispatch'])(
    'Start versus dispatch honors the first %s reservation',
    (first) => {
      const [live, normal] = fixture();
      if (first === 'start') {
        live.start('run', 'relay', '/app');
        expect(() => normal.reserveDispatch('relay', '/app')).toThrow('LIVE_MODE_ACTIVE');
      } else {
        normal.reserveDispatch('relay', '/app');
        expect(() => live.start('run', 'relay', '/app')).toThrow('LIVE_SESSION_BUSY');
        expect(live.find('run')).toBeUndefined();
        normal.releaseQuiescentDispatch('relay');
        expect(live.start('run', 'relay', '/app').state).toBe('starting');
      }
    },
  );

  it('Stop beats a late ready acknowledgement and restart beats an old Stop', () => {
    const [first, second] = fixture();
    const starting = first.start('run', 'relay', '/app');
    const stopping = second.transition(starting, 'stop');
    expect(() => first.transition(starting, 'ready')).toThrow('LIVE_GENERATION_STALE');
    const recovery = first.transition(stopping, 'restart');
    expect(() => second.transition(stopping, 'cleaned')).toThrow('LIVE_GENERATION_STALE');
    expect(second.find('run')).toEqual(recovery);
  });

  it('releases both claims only after cleaned and never reuses a generation', () => {
    const [first, second] = fixture();
    const idle = inState(first, 'idle');
    const next = second.start('next', 'relay', '/app');
    expect(next.generation).toBeGreaterThan(idle.generation);
    expect(() => first.transition(idle, 'ready')).toThrow('LIVE_STATE_CONFLICT');
    expect(first.find('next')).toEqual(next);
  });

  it.each([
    ['error', 'ready'],
    ['recoveryRequired', 'cleaned'],
    ['active', 'cleaned'],
    ['starting', 'cleaned'],
  ])('rejects the unsafe shortcut %s + %s', (state, event) => {
    const [store] = fixture();
    const run = inState(store, state);
    expect(() => store.transition(run, event)).toThrow('LIVE_STATE_CONFLICT');
    expect(store.find(run.liveId)).toEqual(run);
  });
});

describe('manual control intent survives Live Stop', () => {
  const prior = { enabled: true, manualRevision: 4, planIdentity: 'plan', safe: true };
  it.each([
    ['unchanged', prior, true],
    ['manual Off', { ...prior, enabled: false, manualRevision: 5 }, false],
    ['newer intent', { ...prior, manualRevision: 6 }, false],
    ['different plan', { ...prior, planIdentity: 'other' }, false],
    ['safety pause', { ...prior, safe: false }, false],
  ] as const)('%s produces explicit resumeAvailable=%s', (_name, current, expected) => {
    const before = structuredClone(current);
    expect(resumeAvailable(prior, current)).toBe(expected);
    expect(current).toEqual(before);
  });
  it('a disabled prior snapshot cannot offer automatic resume', () => {
    expect(resumeAvailable({ ...prior, enabled: false }, prior)).toBe(false);
  });
});
