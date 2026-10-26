/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { applyReadinessActivity } from './readiness-activity.js';
import {
  unknownReadiness,
  type ReadinessState,
} from '../../../shared/contracts/retrieval-readiness.js';

const snapshot = (runtimeId = 'current-runtime') => ({
  runtimeId,
  observedAt: '2026-10-26T12:00:00Z',
  connections: [],
  repositories: [],
});
function observation(
  second: number,
  state: ReadinessState,
  sequence?: number,
  repositoryId = 'repo',
  threadId = 'child',
  runtimeId = 'current-runtime',
) {
  const readiness = unknownReadiness();
  readiness.repository = { id: repositoryId, label: repositoryId };
  readiness.symbols.state = state;
  readiness.references.state = state;
  return {
    type: 'activity.updated',
    occurredAt: `2026-10-26T12:00:0${second}Z`,
    sequence,
    payload: { runtimeId, repositoryReadiness: { threadId, readiness } },
  };
}

it('accepts only observations from the validated runtime after its status snapshot', () => {
  const current = {
    runtimeId: 'current-runtime',
    observedAt: '2026-10-26T12:00:00Z',
    connections: [],
    repositories: [],
  };
  const readiness = unknownReadiness();
  readiness.repository = { id: 'repo', label: 'repo' };
  const payload = {
    runtimeId: 'current-runtime',
    repositoryReadiness: { threadId: 'child', readiness },
  };
  const event = { type: 'activity.updated', occurredAt: '2026-10-26T12:00:01Z', payload };
  expect(applyReadinessActivity(current, event)?.repositories).toHaveLength(1);
  expect(
    applyReadinessActivity(current, {
      ...event,
      payload: { ...payload, runtimeId: 'previous-runtime' },
    }),
  ).toBe(current);
  expect(applyReadinessActivity(current, { ...event, occurredAt: '2026-10-26T11:59:59Z' })).toBe(
    current,
  );
  expect(applyReadinessActivity(current, { ...event, occurredAt: 'invalid' })).toBe(current);
  expect(applyReadinessActivity(null, event)).toBeNull();
  const legacy = { connections: [], repositories: [] };
  expect(applyReadinessActivity(legacy, event)).toBe(legacy);
});

it('does not let ready t1 replace accepted stale t2, even with a later journal sequence', () => {
  const stale = applyReadinessActivity(snapshot(), observation(2, 'stale', 20))!;
  expect(stale.repositories[0].readiness.symbols.state).toBe('stale');
  expect(applyReadinessActivity(stale, observation(1, 'ready', 21))).toBe(stale);
  expect(applyReadinessActivity(stale, observation(3, 'ready', 19))).toBe(stale);
});

it('rejects duplicates and unorderable ties; accepts a strictly newer supported sequence at equal time', () => {
  const stale = applyReadinessActivity(snapshot(), observation(2, 'stale', 20))!;
  expect(applyReadinessActivity(stale, observation(2, 'ready', 20))).toBe(stale);
  expect(applyReadinessActivity(stale, observation(2, 'ready', 19))).toBe(stale);
  expect(applyReadinessActivity(stale, observation(2, 'ready'))).toBe(stale);
  expect(
    applyReadinessActivity(stale, observation(2, 'ready', 21))?.repositories[0].readiness.references
      .state,
  ).toBe('ready');
  const unsequenced = applyReadinessActivity(snapshot(), observation(2, 'stale'))!;
  expect(applyReadinessActivity(unsequenced, observation(2, 'ready', 100))).toBe(unsequenced);
  expect(
    applyReadinessActivity(unsequenced, observation(3, 'ready'))?.repositories[0].readiness
      .references.state,
  ).toBe('ready');
});

it('orders repository/thread contexts independently while retaining the initial REST floor', () => {
  const a = applyReadinessActivity(snapshot(), observation(2, 'stale', 20))!;
  const b = applyReadinessActivity(a, observation(1, 'ready', 21, 'second-repo'))!;
  const child = applyReadinessActivity(b, observation(1, 'ready', 22, 'repo', 'second-child'))!;
  expect(child.repositories.map((entry) => entry.readiness.symbols.state)).toEqual([
    'stale',
    'ready',
    'ready',
  ]);
  expect(applyReadinessActivity(child, observation(1, 'ready', 23))).toBe(child);
  expect(applyReadinessActivity(child, observation(0, 'ready', 24, 'third-repo'))).toBe(child);
});

it('resets ordering only through a fresh runtime/status snapshot and rejects events from before reconnect', () => {
  const previous = applyReadinessActivity(snapshot(), observation(2, 'stale', 20))!;
  const revalidated = { ...previous, observedAt: '2026-10-26T12:00:03Z' };
  expect(applyReadinessActivity(revalidated, observation(2, 'ready', 99))).toBe(revalidated);
  const next = snapshot('new-runtime');
  expect(applyReadinessActivity(next, observation(4, 'ready', 100))).toBe(next);
  expect(
    applyReadinessActivity(next, observation(1, 'ready', 1, 'repo', 'child', 'new-runtime'))
      ?.repositories[0].readiness.symbols.state,
  ).toBe('ready');
});
