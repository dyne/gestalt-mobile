/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DomainError } from './errors.js';
import type { RelaySessionEvent } from './events.js';
import {
  interactionId,
  profileName,
  sessionId,
  threadId,
  turnId,
  workspaceId,
  workspacePath,
} from './value-objects.js';

export type SessionState =
  'starting' | 'ready' | 'turnActive' | 'recovering' | 'attentionRequired' | 'stopped' | 'released';
export type DesiredState = 'active' | 'stopped';
export type PendingInteraction = {
  requestId: string;
  kind: 'commandApproval' | 'fileChangeApproval' | 'permissionsApproval' | 'userInput';
  payload: unknown;
};
export type RelaySessionSnapshot = {
  id: string;
  workspaceId: string;
  workspacePath: string;
  profile: string;
  threadId: string | null;
  state: SessionState;
  desiredState: DesiredState;
  activeTurnId: string | null;
  protocolVersion: string | null;
  failureCount: number;
  pendingInteractions: PendingInteraction[];
  createdAt: string;
  updatedAt: string;
};

export class RelaySession {
  private constructor(
    private readonly value: RelaySessionSnapshot,
    readonly events: readonly RelaySessionEvent[] = [],
  ) {}

  static create(input: {
    id: string;
    workspaceId: string;
    workspacePath: string;
    profile: string;
    now: string;
  }): RelaySession {
    return new RelaySession({
      id: sessionId(input.id),
      workspaceId: workspaceId(input.workspaceId),
      workspacePath: workspacePath(input.workspacePath),
      profile: profileName(input.profile),
      threadId: null,
      state: 'starting',
      desiredState: 'active',
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static fromExistingThread(input: {
    id: string;
    workspaceId: string;
    workspacePath: string;
    profile: string;
    threadId: string;
    now: string;
  }): RelaySession {
    return new RelaySession({
      id: sessionId(input.id),
      workspaceId: workspaceId(input.workspaceId),
      workspacePath: workspacePath(input.workspacePath),
      profile: profileName(input.profile),
      threadId: threadId(input.threadId),
      state: 'stopped',
      desiredState: 'stopped',
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(snapshot: RelaySessionSnapshot): RelaySession {
    return new RelaySession(copy(snapshot));
  }
  get snapshot(): RelaySessionSnapshot {
    return copy(this.value);
  }

  bindThread(value: string, now: string): RelaySession {
    return this.transition({ threadId: threadId(value), state: 'ready' }, 'ThreadBound', now);
  }
  startTurn(value: string, now: string): RelaySession {
    if (this.value.state === 'turnActive') throw new DomainError('SESSION_TURN_ACTIVE');
    if (this.value.state !== 'ready') throw new DomainError('SESSION_NOT_READY');
    return this.transition(
      { state: 'turnActive', activeTurnId: turnId(value) },
      'TurnStarted',
      now,
    );
  }
  completeTurn(value: string, now: string): RelaySession {
    if (this.value.activeTurnId !== value) throw new DomainError('TURN_NOT_ACTIVE');
    return this.transition({ state: 'ready', activeTurnId: null }, 'TurnCompleted', now);
  }
  requestInteraction(input: PendingInteraction, now: string): RelaySession {
    if (this.value.pendingInteractions.some((item) => item.requestId === input.requestId))
      throw new DomainError('INTERACTION_ALREADY_PENDING');
    return this.transition(
      {
        pendingInteractions: [
          ...this.value.pendingInteractions,
          { ...input, requestId: interactionId(input.requestId) },
        ],
      },
      'InteractionRequested',
      now,
    );
  }
  resolveInteraction(requestId: string, now: string): RelaySession {
    if (!this.value.pendingInteractions.some((item) => item.requestId === requestId))
      throw new DomainError('INTERACTION_NOT_PENDING');
    return this.transition(
      {
        pendingInteractions: this.value.pendingInteractions.filter(
          (item) => item.requestId !== requestId,
        ),
      },
      'InteractionResolved',
      now,
    );
  }
  beginRecovery(now: string): RelaySession {
    return this.transition(
      {
        state: 'recovering',
        desiredState: 'active',
        activeTurnId: null,
        failureCount: this.value.failureCount + 1,
      },
      'RecoveryBegan',
      now,
    );
  }
  restore(now: string): RelaySession {
    return this.transition(
      { state: 'ready', desiredState: 'active', activeTurnId: null, failureCount: 0 },
      'SessionRestored',
      now,
    );
  }
  requireAttention(now: string): RelaySession {
    return this.transition(
      { state: 'attentionRequired', activeTurnId: null },
      'AttentionRequired',
      now,
    );
  }
  stop(now: string): RelaySession {
    return this.transition(
      { state: 'stopped', desiredState: 'stopped', activeTurnId: null },
      'SessionStopped',
      now,
    );
  }
  release(now: string): RelaySession {
    return this.transition(
      { state: 'released', desiredState: 'stopped', activeTurnId: null },
      'SessionReleased',
      now,
    );
  }

  private transition(
    change: Partial<RelaySessionSnapshot>,
    type: RelaySessionEvent['type'],
    now: string,
  ): RelaySession {
    const next = {
      ...this.value,
      ...change,
      pendingInteractions: change.pendingInteractions ?? this.value.pendingInteractions,
      updatedAt: now,
    };
    return new RelaySession(next, [{ type, occurredAt: now, sessionId: this.value.id }]);
  }
}

function copy(snapshot: RelaySessionSnapshot): RelaySessionSnapshot {
  return {
    ...snapshot,
    pendingInteractions: snapshot.pendingInteractions.map((item) => ({ ...item })),
  };
}
