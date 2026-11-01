/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  parseOrgPlanCheckpoint,
  toOrgPlanCheckpointToolResponse,
  type OrgPlanCheckpoint,
  type OrgPlanCheckpointRecordStatus,
} from '../../../../shared/contracts/org-plan-checkpoint.js';
import {
  RelaySession,
  type PendingInteraction,
  type RelaySessionSnapshot,
} from '../../sessions/model/relay-session.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import {
  hasActiveL1Writer,
  resolveOrgPlanCheckpointSignal,
  validateOrgPlanCheckpoint,
} from './validate.js';

type FailureDetails = Readonly<{
  expected?: Readonly<Record<string, string | boolean | null>>;
  observed?: Readonly<Record<string, string | boolean | null>>;
}>;

/** A captured writer capability retains runtime identity without exposing its implementation. */
export interface CheckpointRecoveryWriter {
  activeTurnId: string | null;
  current(): boolean;
  recycle(occurredAt: string): Promise<RelaySessionSnapshot>;
}

export interface CheckpointCoordinationPorts {
  plans: {
    refresh(sessionId: string): Promise<boolean>;
    find(sessionId: string): SupervisedPlan | null;
    identity(sessionId: string): string | null;
    publicationReason(sessionId: string): string | null;
    completedTargets(sessionId: string): readonly string[] | undefined;
    pendingTarget(sessionId: string): string | undefined;
  };
  activity(sessionId: string): Parameters<typeof hasActiveL1Writer>[0];
  pending: {
    add(sessionId: string, interaction: PendingInteraction): void;
    find(sessionId: string, requestId: string): PendingInteraction | null;
    list(sessionId: string): PendingInteraction[];
    resolve(
      sessionId: string,
      requestId: string,
      occurredAt: string,
      outcome: 'answered' | 'failed',
    ): boolean;
  };
  autopilot: {
    accept(
      sessionId: string,
      checkpoint: OrgPlanCheckpoint,
      turnId: string,
      occurredAt: string,
    ): OrgPlanCheckpointRecordStatus;
    failed(sessionId: string, turnId: string | null): boolean;
    recover(sessionId: string): void;
  };
  writer: {
    resolve(sessionId: string, requestId: string, response: unknown): boolean;
    reject(sessionId: string, requestId: string, error: Error): boolean | undefined;
    recovery(sessionId: string): CheckpointRecoveryWriter | null;
  };
  currentTurn(sessionId: string): string | null | undefined;
  saveSession(session: RelaySessionSnapshot): void;
  turnCompleted(sessionId: string, occurredAt: string): void;
  publishFailure(sessionId: string, requestId: string, occurredAt: string): void;
  publishSettlement(
    sessionId: string,
    requestId: string,
    occurredAt: string,
    outcome: 'answered' | 'failed',
  ): void;
  failureResponse(reasonCode: string, details?: FailureDetails): unknown;
  now(): string;
  schedule(callback: () => void, delayMs: number): () => void;
  deadlineMs: number;
}

/** One lifetime owner for checkpoint deadlines and in-progress writer recoveries. */
export class CheckpointCoordination {
  private readonly timers = new Map<string, { cancel(): void; token: symbol }>();
  private readonly recoveries = new Set<string>();

  constructor(private readonly ports: CheckpointCoordinationPorts) {}

  /** null means the read barrier succeeded; otherwise return the exact transport outcome. */
  async refresh(sessionId: string, requestId: string): Promise<boolean | null> {
    if (await this.ports.plans.refresh(sessionId)) return null;
    return this.replyFailure(sessionId, requestId, 'planProjectionUnavailable');
  }

  expand(
    sessionId: string,
    requestId: string,
    kind: OrgPlanCheckpoint['kind'],
  ): { interaction: PendingInteraction } | { handled: boolean } {
    const retained = this.ports.plans.find(sessionId);
    const identity = this.ports.plans.identity(sessionId);
    const checkpoint =
      retained && identity
        ? resolveOrgPlanCheckpointSignal(
            kind,
            retained,
            identity,
            this.ports.plans.publicationReason(sessionId),
            this.ports.plans.completedTargets(sessionId),
            this.ports.plans.pendingTarget(sessionId),
          )
        : null;
    return checkpoint
      ? { interaction: { requestId, kind: 'orgPlanCheckpoint', payload: checkpoint } }
      : {
          handled: this.ports.writer.resolve(
            sessionId,
            requestId,
            toOrgPlanCheckpointToolResponse('failed', {
              reasonCode: 'checkpointBoundaryAmbiguous',
            }),
          ),
        };
  }

  accept(
    sessionId: string,
    interaction: PendingInteraction,
    authority: {
      activeTurnId: string | null;
      rootOwned: boolean;
      compactKind: OrgPlanCheckpoint['kind'] | null;
    },
  ): boolean {
    const checkpoint = parseOrgPlanCheckpoint(interaction.payload);
    const retained = this.ports.plans.find(sessionId);
    const identity = this.ports.plans.identity(sessionId);
    const { activeTurnId, rootOwned, compactKind } = authority;
    if (!checkpoint || !retained || !identity || checkpoint.planIdentity !== identity || !rootOwned)
      return this.replyFailure(
        sessionId,
        interaction.requestId,
        !checkpoint
          ? compactKind === 'l1Accepted'
            ? 'acceptedL1NotResolved'
            : 'checkpointPayloadInvalid'
          : !retained
            ? 'planProjectionUnavailable'
            : !identity || checkpoint.planIdentity !== identity
              ? 'planIdentityMismatch'
              : 'rootNotOwner',
      );
    const validation = validateOrgPlanCheckpoint({
      checkpoint,
      plan: retained,
      planIdentity: identity,
      rootOwned,
      hasActiveL1Writer: (position) => hasActiveL1Writer(this.ports.activity(sessionId), position),
    });
    if (!validation.valid || !activeTurnId)
      return this.replyFailure(
        sessionId,
        interaction.requestId,
        validation.valid ? 'rootTurnNotActive' : validation.reasonCode,
        {
          ...(!validation.valid && validation.expected ? { expected: validation.expected } : {}),
          ...(!validation.valid && validation.observed ? { observed: validation.observed } : {}),
        },
      );
    let recordStatus: OrgPlanCheckpointRecordStatus = 'failed';
    try {
      recordStatus = this.ports.autopilot.accept(
        sessionId,
        checkpoint,
        activeTurnId,
        this.ports.now(),
      );
    } catch {
      if (!this.ports.autopilot.failed(sessionId, activeTurnId))
        return this.replyFailure(sessionId, interaction.requestId, 'checkpointPersistenceFailed');
      this.ports.pending.add(sessionId, {
        ...interaction,
        turnId: activeTurnId,
        requestedAt: this.ports.now(),
      });
      this.fail(sessionId, interaction.requestId, activeTurnId);
      return true;
    }
    if (recordStatus === 'failed')
      return this.replyFailure(sessionId, interaction.requestId, 'checkpointStateConflict');
    if (recordStatus === 'alreadyRecorded')
      return this.ports.writer.resolve(
        sessionId,
        interaction.requestId,
        toOrgPlanCheckpointToolResponse('alreadyRecorded'),
      );
    this.ports.pending.add(sessionId, {
      ...interaction,
      turnId: activeTurnId,
      requestedAt: this.ports.now(),
    });
    this.arm(sessionId, interaction.requestId, activeTurnId);
    try {
      this.ports.writer.resolve(
        sessionId,
        interaction.requestId,
        toOrgPlanCheckpointToolResponse('recorded'),
      );
    } catch {
      // The accepted hold remains owned by the bounded deadline.
    }
    return true;
  }

  responseSettled(
    sessionId: string,
    requestId: string,
    outcome: 'resultWritten' | 'errorWritten' | 'writeFailed',
  ): void {
    const interaction = this.ports.pending.find(sessionId, requestId);
    if (interaction?.kind !== 'orgPlanCheckpoint') return;
    if (outcome !== 'resultWritten') {
      this.fail(sessionId, requestId, interaction.turnId ?? null);
      return;
    }
    this.cancel(sessionId, requestId);
    const occurredAt = this.ports.now();
    if (this.ports.pending.resolve(sessionId, requestId, occurredAt, 'answered'))
      this.ports.publishSettlement(sessionId, requestId, occurredAt, 'answered');
  }

  failPending(sessionId: string, recoverBoundary: boolean): void {
    for (const interaction of this.ports.pending.list(sessionId)) {
      if (interaction.kind !== 'orgPlanCheckpoint') continue;
      this.fail(sessionId, interaction.requestId, interaction.turnId ?? null);
    }
    if (recoverBoundary) this.ports.autopilot.recover(sessionId);
  }

  disposeSession(sessionId: string): void {
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      timer.cancel();
      this.timers.delete(key);
    }
  }

  private replyFailure(
    sessionId: string,
    requestId: string,
    reason: string,
    details?: FailureDetails,
  ): boolean {
    return this.ports.writer.resolve(
      sessionId,
      requestId,
      this.ports.failureResponse(reason, details),
    );
  }

  private cancel(sessionId: string, requestId: string): void {
    const key = `${sessionId}:${requestId}`;
    const timer = this.timers.get(key);
    if (!timer) return;
    timer.cancel();
    this.timers.delete(key);
  }

  private arm(sessionId: string, requestId: string, turnId: string): void {
    this.cancel(sessionId, requestId);
    const key = `${sessionId}:${requestId}`;
    const token = Symbol(key);
    const cancel = this.ports.schedule(() => {
      if (this.timers.get(key)?.token !== token) return;
      this.timers.delete(key);
      this.fail(sessionId, requestId, turnId);
    }, this.ports.deadlineMs);
    this.timers.set(key, { cancel, token });
  }

  /** Fail once and retain the durable root boundary until guarded runtime recovery. */
  private fail(sessionId: string, requestId: string, turnId: string | null): boolean {
    this.cancel(sessionId, requestId);
    const occurredAt = this.ports.now();
    if (!this.ports.pending.resolve(sessionId, requestId, occurredAt, 'failed')) return false;
    this.ports.autopilot.failed(sessionId, turnId);
    this.ports.publishFailure(sessionId, requestId, occurredAt);
    this.ports.publishSettlement(sessionId, requestId, occurredAt, 'failed');
    const rejected = this.ports.writer.reject(
      sessionId,
      requestId,
      new Error('CHECKPOINT_HANDOFF_FAILED'),
    );
    if (rejected === false) {
      const key = `${sessionId}:${requestId}`;
      const recovery = this.ports.writer.recovery(sessionId);
      if (recovery && recovery.activeTurnId === turnId && !this.recoveries.has(key)) {
        this.recoveries.add(key);
        void this.recover(sessionId, turnId, key, recovery);
      }
    }
    return true;
  }

  private async recover(
    sessionId: string,
    turnId: string | null,
    key: string,
    writer: CheckpointRecoveryWriter,
  ): Promise<void> {
    try {
      if (!writer.current() || this.ports.currentTurn(sessionId) !== turnId) return;
      const rebuilt = await writer.recycle(this.ports.now());
      if (!writer.current()) return;
      const recovered =
        turnId && rebuilt.activeTurnId === turnId
          ? RelaySession.rehydrate(rebuilt).completeTurn(turnId, this.ports.now()).snapshot
          : rebuilt;
      this.ports.saveSession(recovered);
      this.ports.turnCompleted(sessionId, this.ports.now());
      this.ports.autopilot.recover(sessionId);
    } catch {
      // Durable failure remains visible; normal runtime recovery may retry later.
    } finally {
      this.recoveries.delete(key);
    }
  }
}
