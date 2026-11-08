/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteOrgPlanLaunchStore } from './sqlite-org-plan-launch-store.js';
import type { OrgPlanLaunchRecord } from '../../features/plans/application/org-plan-launch-store.js';
import { newSessionFallback } from '../../../shared/contracts/session-defaults.js';
import { SqliteSessionRepository } from './sqlite-session-repository.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';

function record(): OrgPlanLaunchRecord {
  return {
    launchId: 'intent',
    sessionId: 'ordinary',
    requestFingerprint: 'confirmed-inputs',
    canonicalPath: '/project/.gestalt/plan.org',
    phase: 'reserved',
    context: {
      kind: 'eligible',
      reference: { kind: 'workspace', workspaceId: 'project', planName: '.gestalt/plan.org' },
      title: 'Plan',
      revision: 'confirmed',
      sourcePath: '/project/.gestalt/plan.org',
      workspace: { id: 'project', path: '/project', name: 'Project' },
      settings: { ...newSessionFallback, provider: 'codex', profile: 'default', skillProfile: '' },
      skillProfiles: [],
      warnings: [],
    },
    skillSelection: {
      skills: [{ name: 'gestalt:org-plan', path: '/skills/org/SKILL.md', enabled: true }],
    },
  };
}

it('fences canonical owners and conditional stages across independent application store instances', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const first = new SqliteOrgPlanLaunchStore(db);
    const second = new SqliteOrgPlanLaunchStore(db);
    const initial = record();
    expect(first.reserve(initial).kind).toBe('reserved');
    expect(second.reserve({ ...initial, sessionId: 'another-allocation' })).toMatchObject({
      kind: 'existing',
      record: { sessionId: 'ordinary' },
    });
    expect(
      second.reserve({ ...initial, launchId: 'other-intent', sessionId: 'other-session' }),
    ).toMatchObject({ kind: 'owned', record: { sessionId: 'ordinary' } });
    expect(first.save({ ...initial, phase: 'creating' }, 'reserved')).toBe(true);
    expect(second.save({ ...initial, phase: 'creating' }, 'reserved')).toBe(false);
    expect(second.forSession('ordinary')).toMatchObject({ phase: 'creating' });
  } finally {
    db.close();
  }
});

it('retains immutable defaults/profile bytes and receipts separately from released canonical ownership', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const store = new SqliteOrgPlanLaunchStore(db);
    const initial = record();
    store.reserve(initial);
    initial.context.settings.model = 'changed';
    expect(store.find(initial.launchId)?.context.settings.model).toBe(newSessionFallback.model);
    store.releaseOwner(initial);
    expect(store.owner(initial.canonicalPath)).toBeNull();
    expect(store.find(initial.launchId)?.canonicalPath).toBe(initial.canonicalPath);
    expect(store.reserve({ ...record(), launchId: 'later', sessionId: 'later-session' }).kind).toBe(
      'reserved',
    );
  } finally {
    db.close();
  }
});

it('rolls back session publication and its launch stage together before any publication receipt exists', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const store = new SqliteOrgPlanLaunchStore(db);
    const sessions = new SqliteSessionRepository(db);
    const initial = { ...record(), phase: 'creating' as const };
    store.reserve(initial);
    const snapshot = RelaySession.create({
      id: initial.sessionId,
      workspaceId: 'project',
      workspacePath: '/project',
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: '2026-11-08T12:00:00Z',
    }).snapshot;
    expect(() =>
      store.publishSession(initial, snapshot, {
        find: (id) => sessions.find(id),
        save: (value) => {
          sessions.save(value);
          throw new Error('write failed before commit');
        },
      }),
    ).toThrow('write failed before commit');
    expect(sessions.list()).toHaveLength(0);
    expect(store.find(initial.launchId)?.phase).toBe('creating');
    expect(store.publishSession(initial, snapshot, sessions)).toMatchObject({
      created: true,
      session: { id: initial.sessionId },
    });
    sessions.save(
      RelaySession.rehydrate(sessions.find(initial.sessionId)!).stop('2026-11-08T12:01:00Z')
        .snapshot,
    );
    expect(store.publishSession(initial, snapshot, sessions)).toMatchObject({
      created: false,
      session: { state: 'stopped' },
    });
    expect(sessions.list()).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('atomically tracks initial activation and fences superseded preparation before provider thread requests', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const first = new SqliteOrgPlanLaunchStore(db);
    const second = new SqliteOrgPlanLaunchStore(db);
    const sessions = new SqliteSessionRepository(db);
    const initial = { ...record(), phase: 'creating' as const };
    const snapshot = RelaySession.create({
      id: initial.sessionId,
      workspaceId: 'project',
      workspacePath: '/project',
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: initial.skillSelection,
      now: '2026-11-08T12:00:00Z',
    }).snapshot;
    first.reserve(initial);
    first.publishSession(initial, snapshot, sessions);
    const older = first.claimInitialActivation(snapshot.id, sessions)!;
    const newer = second.claimInitialActivation(snapshot.id, sessions)!;
    expect(newer.revision).toBeGreaterThan(older.revision);
    expect(first.requestInitialThread(older, sessions)).toBe(false);
    first.failInitialActivation(older);
    expect(second.initialActivationCurrent(newer, sessions)).toBe(true);
    expect(second.requestInitialThread(newer, sessions)).toBe(true);
    expect(first.claimInitialActivation(snapshot.id, sessions)).toBeNull();
    second.failInitialActivation(newer);
    expect(first.claimInitialActivation(snapshot.id, sessions)).toBeNull();
    const active = RelaySession.rehydrate(snapshot).bindThread(
      'provider-thread',
      snapshot.updatedAt,
    ).snapshot;
    expect(first.completeInitialActivation(older, active, sessions)).toBe(false);
    expect(second.completeInitialActivation(newer, active, sessions)).toBe(true);
    expect(sessions.find(snapshot.id)?.threadId).toBe('provider-thread');
    expect(first.claimInitialActivation(snapshot.id, sessions)).toBeNull();
  } finally {
    db.close();
  }
});

it('retries only tracked pre-request failure and never publishes over Stop or recreates a removed row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const store = new SqliteOrgPlanLaunchStore(db);
    const sessions = new SqliteSessionRepository(db);
    const initial = { ...record(), phase: 'creating' as const };
    const snapshot = RelaySession.create({
      id: initial.sessionId,
      workspaceId: 'project',
      workspacePath: '/project',
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: initial.skillSelection,
      now: '2026-11-08T12:00:00Z',
    }).snapshot;
    store.reserve(initial);
    store.publishSession(initial, snapshot, sessions);
    const failed = store.claimInitialActivation(snapshot.id, sessions)!;
    store.failInitialActivation(failed);
    const retry = store.claimInitialActivation(snapshot.id, sessions)!;
    expect(retry.revision).toBeGreaterThan(failed.revision);
    expect(store.requestInitialThread(retry, sessions)).toBe(true);
    const active = RelaySession.rehydrate(snapshot).bindThread(
      'provider-thread',
      snapshot.updatedAt,
    ).snapshot;
    sessions.save(RelaySession.rehydrate(snapshot).stop(snapshot.updatedAt).snapshot);
    expect(store.completeInitialActivation(retry, active, sessions)).toBe(false);
    expect(sessions.find(snapshot.id)?.desiredState).toBe('stopped');
    sessions.remove(snapshot.id);
    expect(store.completeInitialActivation(retry, active, sessions)).toBe(false);
    expect(sessions.find(snapshot.id)).toBeNull();
    sessions.save(snapshot);
    db.prepare('DELETE FROM org_plan_initial_activations WHERE session_id=?').run(snapshot.id);
    expect(store.claimInitialActivation(snapshot.id, sessions)).toBeNull();
  } finally {
    db.close();
  }
});
