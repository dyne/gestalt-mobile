import { describe, expect, it } from 'vitest';

import { RelaySession } from './relay-session.js';
import { DomainError } from './errors.js';

const createdAt = '2026-07-14T00:00:00.000Z';
const session = () =>
  RelaySession.create({
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspacePath: '/work/project',
    profile: 'default',
    now: createdAt,
  });

describe('RelaySession', () => {
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
