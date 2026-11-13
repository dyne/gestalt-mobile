/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AutopilotSession } from '../domain/autopilot-session.js';
import { disabledAutopilot } from '../domain/autopilot-session.js';
import {
  currentExecutableL1Index,
  type SupervisedPlan,
} from '../../plans/domain/supervised-plan.js';
import { fingerprint as planFingerprint } from './service.js';
import {
  executorAssignment,
  executorIdentity,
  type ExecutorIdentity,
} from '../domain/supervised-lifecycle.js';
import { startSupervisionProtocol } from '../domain/supervision-protocol.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import type { AutopilotAuditEvent } from './ports.js';

export type TakeoverClaim = Readonly<{
  planIdentity: string;
  sessionId: string;
  epoch: number;
  phase: 'stopping' | 'ready';
}>;
export type TakeoverRecoveryState = Pick<
  AutopilotSession,
  'sessionId' | 'updatedAt' | 'executor' | 'checkpoints'
>;
export type TakeoverRecovery = Readonly<{
  epoch: number | null;
  verified: boolean;
  sessionIds: readonly string[];
  states: readonly TakeoverRecoveryState[];
}>;
export interface SupervisionTakeoverStore {
  owner(planIdentity: string): TakeoverClaim | null;
  recovery(
    planIdentity: string,
    workspacePath: string,
    knownSessionIds: readonly string[],
  ): TakeoverRecovery;
  claim(
    planIdentity: string,
    sessionId: string,
    expectedEpoch?: number | null,
  ): TakeoverClaim | null;
  retire(claim: TakeoverClaim, sessionIds: readonly string[]): boolean;
  stopped(planIdentity: string, sessionId: string): boolean;
  markStopped(claim: TakeoverClaim, sessionId: string): boolean;
  complete(
    claim: TakeoverClaim,
    state: AutopilotSession,
    events: readonly AutopilotAuditEvent[],
    root: Readonly<{ threadId: string; turnId: string }>,
  ): boolean;
}
type Context = Readonly<{
  session: RelaySessionSnapshot;
  plan: SupervisedPlan;
  identity: string;
  state: AutopilotSession | null;
  admission: boolean;
  held: boolean;
  localExecutor: boolean;
}>;
type Predecessor = Readonly<{ session: RelaySessionSnapshot; state: AutopilotSession }>;
type Result =
  | { accepted: false; code: string; boundary?: string }
  | { accepted: true; alreadyOwner: true }
  | {
      accepted: true;
      alreadyOwner: boolean;
      identity: ExecutorIdentity;
      previousSessionIds: string[];
      boundaryFinalRequired: boolean;
    };

/** Explicit user direction supplies authority. Runtime quiescence supplies sole-writer evidence. */
export class SupervisionTakeover {
  private readonly running = new Map<string, Promise<Result>>();
  constructor(
    private readonly deps: {
      store: SupervisionTakeoverStore;
      now(): string;
      context(sessionId: string): Context | null;
      predecessors(context: Context): readonly Predecessor[];
      fence(sessionId: string): void;
      stop(previous: Predecessor): Promise<boolean>;
      changed(sessionId: string): void;
      failed?(sessionId: string, boundary: string): void;
    },
  ) {}

  takeOver(sessionId: string, threadId: string, turnId: string): Promise<Result> {
    const prior = this.running.get(sessionId);
    if (prior) return prior;
    let boundary = 'context';
    const run = this.run(sessionId, threadId, turnId, (value) => {
      boundary = value;
    }).catch((): Result => {
      try {
        this.deps.failed?.(sessionId, boundary);
      } catch {
        /* diagnostics must not change the takeover result */
      }
      return { accepted: false, code: 'TAKEOVER_RUNTIME_UNAVAILABLE', boundary };
    });
    this.running.set(sessionId, run);
    void run.finally(() => {
      if (this.running.get(sessionId) === run) this.running.delete(sessionId);
    });
    return run;
  }

  private async run(
    sessionId: string,
    threadId: string,
    turnId: string,
    boundary: (value: string) => void,
  ): Promise<Result> {
    const before = this.deps.context(sessionId);
    if (
      !before ||
      before.session.provider !== 'codex' ||
      before.session.threadId !== threadId ||
      before.session.activeTurnId !== turnId
    )
      return { accepted: false, code: 'CURRENT_ROOT_REQUIRED' };
    if (!before.admission) return { accepted: false, code: 'EXECUTION_POLICY_UNAVAILABLE' };
    if (before.held) return { accepted: false, code: 'PENDING_INTERACTION' };
    const index = currentExecutableL1Index(before.plan);
    if (index < 0 || before.plan.executionComplete)
      return { accepted: false, code: 'NO_UNFINISHED_MILESTONE' };
    const existing = this.deps.store.owner(before.identity);
    if (existing?.sessionId === sessionId && existing.phase === 'ready') {
      const pending = before.state?.executor?.replacement;
      const identity =
        pending &&
        pending.planIdentity === before.identity &&
        pending.planFingerprint === planFingerprint(before.plan) &&
        pending.canonicalPosition === `L${index + 1}`
          ? executorIdentity(pending.canonicalTaskName, pending.generation)
          : !before.state?.executor
            ? executorIdentity(`l${index + 1}`, 1)
            : null;
      if (!before.localExecutor && identity)
        return {
          accepted: true,
          alreadyOwner: true,
          identity,
          previousSessionIds: [],
          boundaryFinalRequired: Boolean(before.state?.checkpoints?.pendingTurnId),
        };
      return { accepted: true, alreadyOwner: true };
    }
    if (before.localExecutor) return { accepted: false, code: 'CURRENT_EXECUTOR_ALREADY_PRESENT' };
    const previous = this.deps
      .predecessors(before)
      .filter(
        (p) =>
          p.session.id !== sessionId &&
          p.session.provider === 'codex' &&
          p.session.workspacePath === before.session.workspacePath &&
          p.state.planIdentity === before.identity,
      );
    const recovery = this.deps.store.recovery(before.identity, before.session.workspacePath, [
      sessionId,
      ...previous.map((p) => p.session.id),
    ]);
    if (!recovery.verified) return { accepted: false, code: 'PREVIOUS_WRITER_STATUS_UNKNOWN' };
    const fingerprint = planFingerprint(before.plan);
    const generation = before.state?.generation ?? 0;
    boundary('ownershipReservation');
    const claim = this.deps.store.claim(before.identity, sessionId, recovery.epoch);
    if (!claim) return { accepted: false, code: 'TAKEOVER_IN_PROGRESS' };
    if (
      !this.deps.store.retire(claim, [
        ...new Set([...previous.map((p) => p.session.id), ...recovery.sessionIds]),
      ])
    )
      return { accepted: false, code: 'TAKEOVER_CONTEXT_CHANGED' };
    // Fence every predecessor before the first asynchronous process operation.
    boundary('fencePreviousSupervisor');
    for (const p of previous)
      if (!this.deps.store.stopped(before.identity, p.session.id)) this.deps.fence(p.session.id);
    for (const p of previous) {
      if (this.deps.store.stopped(before.identity, p.session.id)) continue;
      boundary('quiescePreviousWriter');
      if (!(await this.deps.stop(p)))
        return { accepted: false, code: 'PREVIOUS_WRITER_NOT_STOPPED' };
      if (!this.deps.store.markStopped(claim, p.session.id))
        return { accepted: false, code: 'TAKEOVER_CONTEXT_CHANGED' };
    }
    for (const id of recovery.sessionIds)
      if (!this.deps.store.markStopped(claim, id))
        return { accepted: false, code: 'TAKEOVER_CONTEXT_CHANGED' };
    boundary('revalidateContext');
    const current = this.deps.context(sessionId);
    if (
      !current ||
      current.session.threadId !== threadId ||
      current.session.activeTurnId !== turnId ||
      current.identity !== before.identity ||
      planFingerprint(current.plan) !== fingerprint ||
      (current.state?.generation ?? 0) !== generation ||
      current.held ||
      current.localExecutor ||
      !current.admission
    )
      return { accepted: false, code: 'TAKEOVER_CONTEXT_CHANGED' };
    const canonicalTaskName = `l${index + 1}`;
    const recoveredStates = [...previous.map((p) => p.state), ...recovery.states];
    const executors = recoveredStates
      .map((state) => state.executor)
      .filter((e) => e?.canonicalTaskName === canonicalTaskName);
    const source = executors.sort(
      (a, b) =>
        (b!.replacement?.generation ?? b!.continuationGeneration) -
        (a!.replacement?.generation ?? a!.continuationGeneration),
    )[0];
    const nextGeneration = source
      ? Math.max(...executors.map((e) => e!.replacement?.generation ?? e!.continuationGeneration)) +
        1
      : 1;
    const identity = executorIdentity(canonicalTaskName, nextGeneration);
    const history =
      current.state?.checkpoints ??
      recoveredStates
        .filter((state) => state.checkpoints?.planIdentity === before.identity)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.checkpoints;
    const now = this.deps.now();
    const state: AutopilotSession = {
      ...(current.state ?? disabledAutopilot(sessionId, now)),
      requestedEnabled: true,
      state: 'monitoring',
      stopReason: null,
      blocking: undefined,
      planIdentity: current.identity,
      planFingerprint: fingerprint,
      generation: generation + 1,
      lastControlId: null,
      nextEvaluationAt: null,
      consecutiveNoProgress: 0,
      supervision: startSupervisionProtocol(fingerprint),
      ...(history
        ? {
            checkpoints: {
              ...history,
              pendingTurnId: history.pendingTurnId ? turnId : null,
              checkpointHandoffFailed: false,
              rootContinuationFromTurnId: undefined,
            },
          }
        : {}),
      executor: source
        ? {
            ...source,
            l1State: current.plan.steps[index]!.state,
            outcome: 'failed',
            blocking: undefined,
            ownedProcesses: [],
            commands: [],
            continuationCount: 0,
            resumeFailures: 0,
            assignment: executorAssignment(source, 'unavailable'),
            replacement: {
              ...identity,
              planIdentity: current.identity,
              planFingerprint: fingerprint,
              previous: executorAssignment(source, 'unavailable'),
              reason: 'userDirectedTakeover',
              evidence: 'explicit-user-takeover',
            },
          }
        : undefined,
      updatedAt: now,
    };
    const previousSessionIds = [
      ...new Set([...previous.map((p) => p.session.id), ...recovery.sessionIds]),
    ];
    boundary('commitOwnership');
    if (
      !this.deps.store.complete(
        claim,
        state,
        [
          {
            sessionId,
            type: 'autopilot.supervisor-taken-over',
            occurredAt: now,
            payload: {
              previousSessionIds,
              canonicalTaskName,
              taskName: identity.taskName,
              generation: identity.generation,
              authority: 'explicit-user-takeover',
            },
          },
        ],
        { threadId, turnId },
      )
    )
      return { accepted: false, code: 'TAKEOVER_CONTEXT_CHANGED' };
    // Publication cannot undo committed ownership or mint another generation.
    // The durable outbox and normal activity reconciliation can retry refresh.
    try {
      this.deps.changed(sessionId);
    } catch {
      /* committed takeover remains accepted */
    }
    return {
      accepted: true,
      alreadyOwner: false,
      identity,
      previousSessionIds,
      boundaryFinalRequired: Boolean(history?.pendingTurnId),
    };
  }
}
