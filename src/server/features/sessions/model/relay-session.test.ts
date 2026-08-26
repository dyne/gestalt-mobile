/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { isSessionReadable, relayOwnsWriter, RelaySession } from './relay-session.js';
import { DomainError } from './errors.js';

const createdAt = '2026-07-14T00:00:00.000Z';
const session = () =>
  RelaySession.create({
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspacePath: '/work/project',
    profile: 'default',
    effectiveSkillSelection: {
      selectedProfileName: 'focused',
      skills: [{ name: 'Focused', path: '/skills/focused/SKILL.md', enabled: true }],
    },
    now: createdAt,
  });

describe('RelaySession', () => {
  it.each([
    ['ready', true, true],
    ['turnActive', true, true],
    ['stopped', true, false],
    ['released', true, false],
    ['attentionRequired', true, false],
    ['recovering', true, false],
  ] as const)(
    'separates detached readability from writer ownership for %s',
    (state, readable, writable) => {
      const snapshot = { ...session().bindThread('thread-1', createdAt).snapshot, state };
      expect(isSessionReadable(snapshot)).toBe(readable);
      expect(relayOwnsWriter(snapshot)).toBe(writable);
    },
  );

  it('does not read a session without a durable thread id', () => {
    expect(isSessionReadable(session().snapshot)).toBe(false);
  });
  it('keeps legacy capability distinct from a supported stopped writer', () => {
    const legacy = RelaySession.fromExistingThread({
      id: 'legacy',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      threadId: 't',
      now: createdAt,
    });
    const supported = legacy.supportsAttentionTool(createdAt).stop(createdAt);
    expect(legacy.snapshot.attentionToolCapability).toBeUndefined();
    expect(supported.snapshot).toMatchObject({
      attentionToolCapability: 'supported',
      state: 'stopped',
      threadId: 't',
    });
  });
  it('keeps a copied effective skill selection through lifecycle transitions', () => {
    const original = session().snapshot;
    const changed = RelaySession.rehydrate(original)
      .beginRecovery(createdAt)
      .restore(createdAt).snapshot;
    expect(changed.effectiveSkillSelection).toEqual(original.effectiveSkillSelection);
    const leaked = changed.effectiveSkillSelection!;
    (leaked.skills as unknown as Array<{ enabled: boolean }>)[0]!.enabled = false;
    expect(original.effectiveSkillSelection?.skills[0]?.enabled).toBe(true);
  });

  it.each([
    ['read-only', 'untrusted'],
    ['workspace-write', 'on-request'],
    ['danger-full-access', 'never'],
  ] as const)('captures the selected execution policy %s / %s', (sandbox, approvalPolicy) => {
    expect(
      RelaySession.create({
        id: 'session-policy',
        workspaceId: 'workspace-1',
        workspacePath: '/work/project',
        profile: 'default',
        sandbox,
        approvalPolicy,
        effectiveSkillSelection: { skills: [] },
        now: createdAt,
      }).snapshot.executionPolicy,
    ).toEqual({ sandbox, approvalPolicy });
  });

  it('normalizes an omitted approval policy without guessing a sandbox', () => {
    expect(
      RelaySession.create({
        id: 'session-default-policy',
        workspaceId: 'workspace-1',
        workspacePath: '/work/project',
        profile: 'default',
        effectiveSkillSelection: { skills: [] },
        now: createdAt,
      }).snapshot.executionPolicy,
    ).toEqual({ approvalPolicy: 'on-request' });
  });

  it('binds a thread and allows exactly one active turn', () => {
    const ready = session().bindThread('thread-1', createdAt);
    const active = ready.startTurn('turn-1', createdAt);

    expect(ready.snapshot.activeTurnId).toBeNull();
    expect(active.snapshot.state).toBe('turnActive');
    expect(() => active.startTurn('turn-2', createdAt)).toThrow(
      new DomainError('SESSION_TURN_ACTIVE'),
    );
  });

  it('requires an unresolved interaction to be resolved once', () => {
    const requested = session()
      .bindThread('thread-1', createdAt)
      .requestInteraction(
        { requestId: 'approval-1', kind: 'commandApproval', payload: { command: 'git status' } },
        createdAt,
      );
    const resolved = requested.resolveInteraction('approval-1', createdAt);

    expect(resolved.snapshot.pendingInteractions).toEqual([]);
    expect(() => resolved.resolveInteraction('approval-1', createdAt)).toThrow(
      new DomainError('INTERACTION_NOT_PENDING'),
    );
  });

  it('keeps released sessions resumable while stopped sessions are not active', () => {
    const released = session().bindThread('thread-1', createdAt).release(createdAt);
    const stopped = session().bindThread('thread-1', createdAt).stop(createdAt);

    expect(released.snapshot).toMatchObject({ state: 'released', desiredState: 'stopped' });
    expect(stopped.snapshot).toMatchObject({ state: 'stopped', desiredState: 'stopped' });
    expect(() => stopped.startTurn('turn-1', createdAt)).toThrow(
      new DomainError('SESSION_NOT_READY'),
    );
  });

  it('imports an existing Codex thread as a resumable stopped session', () => {
    expect(
      RelaySession.fromExistingThread({
        id: 'session-2',
        workspaceId: '/work/imported',
        workspacePath: '/work/imported',
        profile: 'default',
        threadId: 'thread-2',
        now: createdAt,
      }).snapshot,
    ).toMatchObject({
      id: 'session-2',
      threadId: 'thread-2',
      workspacePath: '/work/imported',
      state: 'stopped',
      desiredState: 'stopped',
    });
  });
});
