/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { currentOwningSession, recoveredSession } from './recovered-session.js';
const initial = () =>
  RelaySession.create({
    id: 'relay',
    workspaceId: 'workspace',
    workspacePath: '/project',
    profile: 'default',
    provider: 'codex',
    model: 'selected',
    modelSettings: { reasoningEffort: 'medium' },
    effectiveSkillSelection: { skills: [] },
    now: '2026-10-16T00:00:00Z',
  }).bindThread('thread', '2026-10-16T00:00:01Z').snapshot;
it('preserves newer Relay metadata across a delayed verified Native replacement', () => {
  const before = initial();
  const current = {
    ...before,
    branch: 'new-branch',
    lastOrgPlan: { filename: 'current.org', title: 'Current plan', attached: true },
    failureCount: 3,
    updatedAt: '2026-10-16T00:00:05Z',
  };
  const restored = { ...before, failureCount: 0, updatedAt: '2026-10-16T00:00:03Z' };
  expect(currentOwningSession(before, current)).toEqual(current);
  expect(recoveredSession(current, restored)).toMatchObject({
    branch: 'new-branch',
    lastOrgPlan: current.lastOrgPlan,
    failureCount: 0,
    updatedAt: current.updatedAt,
    state: 'ready',
    modelSettings: before.modelSettings,
    executionPolicy: before.executionPolicy,
  });
  expect(current.failureCount).toBe(3);
});
it.each([
  { model: 'changed' },
  { modelSettings: { reasoningEffort: 'low' } },
  { provider: 'kimi' },
  { threadId: 'other' },
])('refuses changed selection instead of publishing stale recovery %#', (change) => {
  const before = initial();
  expect(() => currentOwningSession(before, { ...before, ...change } as typeof before)).toThrow(
    'LIVE_RELAY_AUTHORIZATION_CHANGED',
  );
});
