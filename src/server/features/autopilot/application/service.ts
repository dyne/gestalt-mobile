/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import { deriveSessionStatus } from '../../sessions/session-status.js';
import { createHash } from 'node:crypto';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
import {
  AUTOPILOT_WAIT_MAX_MS,
  AUTOPILOT_WAIT_MIN_MS,
} from '../../../../shared/contracts/autopilot-wait-lease.js';
import {
  autopilotSnapshot,
  disabledAutopilot,
  type AutopilotSession,
  type AutopilotSnapshot,
} from '../domain/autopilot-session.js';
import {
  classifyExecutorOutcome,
  decideSupervisedLifecycle,
  executorIdentity,
  type ExecutorCommand,
  type ExecutorLifecycle,
  type OwnedExecutorProcess,
  type StructuredBlock,
  type SupervisedLifecycleEvent,
  validStructuredBlock,
  checkpointTarget,
} from '../domain/supervised-lifecycle.js';
import {
  classifyAgentActivity,
  decideAutopilot,
  executionComplete,
  type AutopilotPolicy,
} from './policy.js';
import {
  consumeCheckpointBoundary,
  consumeObsoleteWait,
  consumeObservableWake,
  consumeWaitDeadline,
  recordAutomaticContinuation,
  recoverSafetyPause,
  registerProactiveWait as registerProtocolWait,
  reportProbe,
  semanticProgressKey,
  startSupervisionProtocol,
  type ObservableWake,
  type ObservableWakeCondition,
  type ProbeReport,
} from '../domain/supervision-protocol.js';
import type {
  AutopilotAuditEvent,
  AutopilotControl,
  AutopilotStore,
  AutopilotTurnStarter,
  SupervisedExecutorController,
} from './ports.js';

export type AutopilotDependencies = Readonly<{
  store: AutopilotStore;
  now(): string;
  policy: AutopilotPolicy;
  plan(sessionId: string): Readonly<{ plan: SupervisedPlan; identity: string }> | null;
  session(
    sessionId: string,
  ): Readonly<{ state: string; threadId: string | null; activeTurnId: string | null }> | null;
  activity(sessionId: string): AgentActivitySnapshot | null;
  pendingInteraction(sessionId: string): boolean;
  attention?(sessionId: string): StructuredBlock | null;
  schedule(callback: () => void, delayMs: number): () => void;
  nextControlId(sessionId: string, generation: number): string;
  turnStarter: AutopilotTurnStarter;
  executorController?: SupervisedExecutorController;
  reconcile(sessionId: string): Promise<{ compatible: boolean }>;
  publish(
    sessionId: string,
    type: string,
    payload: unknown,
    occurredAt: string,
    outboxId?: number,
  ): void;
  diagnostic?(sessionId: string, decision: string): void;
}>;

export class AutopilotCoordinator {
  private readonly timers = new Map<string, () => void>();
  private readonly completionTimers = new Map<string, () => void>();
  private readonly executorTimers = new Map<string, () => void>();
  private readonly waitTimers = new Map<string, () => void>();
  private readonly publishedSnapshots = new Map<string, string>();
  private readonly planEventKeys = new Map<string, string>();
  private readonly activityEventKeys = new Map<string, string>();
  /** Durable wait data is not proof that this process has a live subscription. */
  private readonly parkedSubscriptions = new Map<string, string>();
  /** One reconciliation owns a session until it has published its next wake. */
  private readonly reconciling = new Set<string>();
  /** Serializes asynchronous watchdog and timer work per relay session. */
  private readonly operations = new Map<string, Promise<void>>();
  constructor(private readonly deps: AutopilotDependencies) {}

  snapshot(sessionId: string): AutopilotSnapshot {
    const state = this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, this.deps.now());
    const control = state.lastControlId
      ? this.deps.store.findControl(sessionId, state.lastControlId)
      : null;
    return this.snapshotFor(state, control ?? undefined);
  }
  controlIds(sessionId: string): ReadonlySet<string> {
    return this.deps.store.controlIds(sessionId);
  }
  acceptedControlTurns(sessionId: string): ReadonlyMap<string, string> {
    return this.deps.store.acceptedControlTurns?.(sessionId) ?? new Map();
  }
  /** Rehydrates only actionable durable state; terminal rows intentionally create no work. */
  restore(sessionId: string): void {
    this.flushOutbox(sessionId);
    const state = this.deps.store.find(sessionId);
    const session = this.deps.session(sessionId);
    if (
      !state ||
      !session ||
      !session.threadId ||
      !state.requestedEnabled ||
      ['disabled', 'attentionRequired', 'completed', 'safetyPaused'].includes(state.state)
    )
      return;
    // A relay restart deliberately drops its writer before rehydrating the
    // coordinator. The plan-status watcher is authoritative and asynchronous,
    // so retaining enabled durable state until it supplies the projection is
    // safer than interpreting this short bootstrap gap as plan removal.
    const retained = this.deps.plan(sessionId);
    if (!retained) return;
    if (state.supervision?.outcome === 'parked') {
      if (retained.identity !== state.planIdentity) {
        this.parkedSubscriptions.delete(sessionId);
        return;
      }
      const validated = autopilotSnapshot(state, this.deps.policy.retryLimit, {
        activeTurn: Boolean(session.activeTurnId),
        executorActive: false,
        control: 'none',
        timerArmed: false,
        reconciling: false,
        planMatches: true,
        parkedSubscriptionActive: true,
        transitionFresh: true,
        observedAt: this.deps.now(),
      });
      if (state.supervision.waitLease && validated.health.wait.wakeCategories.length > 0) {
        this.parkedSubscriptions.set(sessionId, state.supervision.waitLease.id);
        if (state.supervision.waitLease.resumeAt)
          this.armWaitDeadline(
            sessionId,
            state.supervision.waitLease.id,
            state.supervision.waitLease.resumeAt,
          );
        return;
      }
      this.parkedSubscriptions.delete(sessionId);
    }
    const control = state.lastControlId
      ? this.deps.store.findControl(sessionId, state.lastControlId)
      : null;
    // An issued command may have crossed the app-server acceptance boundary
    // immediately before process loss. Replaying it risks a second logical turn.
    if (control?.status === 'issued') {
      // The runtime persists the accepted active turn before returning from its
      // start capability. Recover that durable acceptance as a single audited
      // control result; the outbox/journal key makes a crash before ack replay
      // the same event rather than manufacture a second turn or audit record.
      if (session.activeTurnId) {
        this.updateControl(
          sessionId,
          control.controlId,
          'started',
          null,
          session.activeTurnId,
          'autopilot.turn-started',
        );
        return;
      }
      this.persist({
        ...state,
        state: 'monitoring',
        requestedEnabled: true,
        generation: state.generation + 1,
        nextEvaluationAt: null,
        stopReason: 'reconcileFailed',
        updatedAt: this.deps.now(),
      });
      this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
      return;
    }
    if (state.state === 'backoff' && state.nextEvaluationAt) {
      this.arm(sessionId, state.generation, state.nextEvaluationAt);
      return;
    }
    this.evaluate(sessionId);
  }
  dispose(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.cancelWaitTimer(sessionId);
    this.planEventKeys.delete(sessionId);
    this.activityEventKeys.delete(sessionId);
    this.reconciling.delete(sessionId);
    this.parkedSubscriptions.delete(sessionId);
  }
  /** Accepts a session-owned structured probe response; no transcript text is inspected. */
  reportProbe(sessionId: string, report: ProbeReport): boolean {
    const state = this.deps.store.find(sessionId);
    if (!state?.requestedEnabled) return false;
    const protocol = state.supervision ?? startSupervisionProtocol(this.progressKey(sessionId));
    const nextProtocol = reportProbe(protocol, report);
    if (nextProtocol === protocol) return false;
    if (nextProtocol.outcome === 'parked' && nextProtocol.waitLease)
      this.parkedSubscriptions.set(sessionId, nextProtocol.waitLease.id);
    else this.parkedSubscriptions.delete(sessionId);
    const now = this.deps.now();
    this.persist({
      ...state,
      supervision: nextProtocol,
      ...(nextProtocol.outcome === 'attentionRequired'
        ? {
            state: 'attentionRequired',
            requestedEnabled: false,
            stopReason: 'attentionRequired' as const,
          }
        : {}),
      updatedAt: now,
    });
    if (nextProtocol.outcome === 'parked' || nextProtocol.outcome === 'attentionRequired')
      this.cancelTimer(sessionId);
    return true;
  }
  /** Parks one explicitly requested long wait without changing future pulse policy. */
  registerProactiveWait(
    sessionId: string,
    report: Readonly<{
      id: string;
      leaseId: string;
      wakeConditions: readonly ObservableWakeCondition[];
      maxWaitMs: number;
    }>,
  ): boolean {
    const state = this.deps.store.find(sessionId);
    if (
      !state?.requestedEnabled ||
      !Number.isSafeInteger(report.maxWaitMs) ||
      report.maxWaitMs < AUTOPILOT_WAIT_MIN_MS ||
      report.maxWaitMs > AUTOPILOT_WAIT_MAX_MS
    )
      return false;
    const now = this.deps.now();
    const resumeAt = new Date(Date.parse(now) + report.maxWaitMs).toISOString();
    const protocol = state.supervision ?? startSupervisionProtocol(this.progressKey(sessionId));
    const nextProtocol = registerProtocolWait(protocol, { ...report, resumeAt });
    if (nextProtocol === protocol) return false;

    const cancelled = this.cancelScheduledControl(state, now);
    this.timers.get(sessionId)?.();
    this.timers.delete(sessionId);
    this.completionTimers.get(sessionId)?.();
    this.completionTimers.delete(sessionId);
    this.parkedSubscriptions.set(sessionId, report.leaseId);
    this.persist(
      {
        ...state,
        state: 'monitoring',
        generation: state.generation + (cancelled ? 1 : 0),
        nextEvaluationAt: null,
        ...(cancelled ? { lastControlId: null } : {}),
        supervision: nextProtocol,
        updatedAt: now,
      },
      cancelled,
    );
    this.armWaitDeadline(sessionId, report.leaseId, resumeAt);
    return true;
  }
  /** Fails closed only for the currently active bounded probe. */
  rejectProbe(sessionId: string): boolean {
    const state = this.deps.store.find(sessionId);
    if (!state?.requestedEnabled || state.supervision?.outcome !== 'probeRequired') return false;
    const now = this.deps.now();
    const cancelled = this.cancelScheduledControl(state, now);
    this.cancelTimer(sessionId);
    this.persist(
      {
        ...state,
        state: 'safetyPaused',
        requestedEnabled: false,
        generation: state.generation + 1,
        nextEvaluationAt: null,
        ...(cancelled ? { lastControlId: null } : {}),
        stopReason: 'safetyPaused',
        supervision: {
          ...state.supervision,
          outcome: 'safetyPaused',
          safetyPauseReason: 'invalidProbeReport',
        },
        updatedAt: now,
      },
      cancelled,
      [
        {
          sessionId,
          type: 'autopilot.safety-paused',
          payload: { reason: 'invalidProbeReport' },
          occurredAt: now,
        },
      ],
    );
    return true;
  }
  /** A durable matching wake grants the one retry and schedules no work by itself. */
  observableWake(sessionId: string, wake: ObservableWake): boolean {
    const state = this.deps.store.find(sessionId);
    if (!state?.requestedEnabled || !state.supervision) return false;
    const nextProtocol = consumeObservableWake(state.supervision, wake);
    if (nextProtocol === state.supervision) return false;
    this.cancelWaitTimer(sessionId);
    this.parkedSubscriptions.delete(sessionId);
    this.persist({ ...state, supervision: nextProtocol, updatedAt: this.deps.now() });
    this.evaluate(sessionId);
    return true;
  }
  /** Wakes a parked lease only when this semantic event was explicitly requested. */
  semanticEvent(sessionId: string, condition: ObservableWakeCondition): boolean {
    const lease = this.deps.store.find(sessionId)?.supervision?.waitLease;
    if (!lease || !lease.wakeConditions.includes(condition)) return false;
    return this.observableWake(sessionId, {
      leaseId: lease.id,
      condition,
      progressKey: this.progressKey(sessionId),
    });
  }
  /** Bridges a completed root-owned background command into its one active wait episode. */
  rootProcessCompleted(sessionId: string, processId: string): boolean {
    const lease = this.deps.store.find(sessionId)?.supervision?.waitLease;
    if (!lease || !processId || processId.length > 256) return false;
    const condition = lease.wakeConditions.includes('processResultAvailable')
      ? 'processResultAvailable'
      : lease.wakeConditions.includes('processExited')
        ? 'processExited'
        : null;
    if (!condition) return false;
    const progressKey = createHash('sha256')
      .update(`${this.progressKey(sessionId)}\0root-process\0${processId}`)
      .digest('hex');
    return this.observableWake(sessionId, { leaseId: lease.id, condition, progressKey });
  }
  enable(sessionId: string): AutopilotSnapshot | { code: string } {
    const session = this.deps.session(sessionId);
    if (!session || !session.threadId || !['ready', 'turnActive'].includes(session.state))
      return { code: 'AUTOPILOT_SESSION_UNAVAILABLE' };
    const currentPlan = this.deps.plan(sessionId);
    if (!currentPlan) return { code: 'AUTOPILOT_PLAN_REQUIRED' };
    if (executionComplete(currentPlan.plan)) return { code: 'AUTOPILOT_PLAN_COMPLETE' };
    const now = this.deps.now();
    const prior = this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, now);
    const nextFingerprint = fingerprint(currentPlan.plan);
    const replacing = Boolean(prior.planIdentity && prior.planIdentity !== currentPlan.identity);
    if (replacing) {
      this.cancelWaitTimer(sessionId);
      this.parkedSubscriptions.delete(sessionId);
    }
    if (
      prior.requestedEnabled &&
      prior.planIdentity === currentPlan.identity &&
      prior.state !== 'attentionRequired'
    )
      return this.snapshot(sessionId);
    const next: AutopilotSession = {
      ...prior,
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: currentPlan.identity,
      planFingerprint: nextFingerprint,
      generation: prior.generation + 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      stopReason: null,
      executor: undefined,
      blocking: undefined,
      supervision: recoverSafetyPause(
        consumeObsoleteWait(
          replacing
            ? startSupervisionProtocol(this.progressKey(sessionId))
            : (prior.supervision ?? startSupervisionProtocol(this.progressKey(sessionId))),
          this.progressKey(sessionId),
        ),
        this.progressKey(sessionId),
      ),
      updatedAt: now,
    };
    this.persist(next);
    this.evaluate(sessionId);
    return this.snapshot(sessionId);
  }
  disable(sessionId: string): AutopilotSnapshot {
    const now = this.deps.now();
    const prior = this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, now);
    // Retain the current plan identity even when Autopilot has not previously
    // been enabled.  That makes an explicit Off a durable, plan-scoped choice
    // instead of a generic disabled default that a later supervision signal
    // could not distinguish from never having been configured.
    const currentPlan = this.deps.plan(sessionId);
    const cancelled = this.cancelScheduledControl(prior, now);
    if (
      !prior.requestedEnabled &&
      prior.state === 'disabled' &&
      !cancelled &&
      !prior.supervision?.waitLease &&
      (!currentPlan || prior.planIdentity === currentPlan.identity)
    )
      return this.snapshot(sessionId);
    const next: AutopilotSession = {
      ...prior,
      state: 'disabled',
      requestedEnabled: false,
      ...(currentPlan ? { planIdentity: currentPlan.identity } : {}),
      generation: prior.generation + 1,
      nextEvaluationAt: null,
      ...(cancelled ? { lastControlId: null } : {}),
      stopReason: 'manualDisabled',
      blocking: undefined,
      supervision: consumeObsoleteWait(
        prior.supervision ?? startSupervisionProtocol(this.progressKey(sessionId)),
        this.progressKey(sessionId),
      ),
      updatedAt: now,
    };
    this.persist(next, cancelled);
    this.cancelTimer(sessionId);
    this.cancelWaitTimer(sessionId);
    this.parkedSubscriptions.delete(sessionId);
    return this.snapshot(sessionId);
  }
  cancel(sessionId: string, reason: 'planRemoved' | 'planReplaced' | 'sessionEnded'): void {
    const prior = this.deps.store.find(sessionId);
    if (!prior) return;
    const now = this.deps.now();
    const cancelled = this.cancelScheduledControl(prior, now);
    this.persist(
      {
        ...prior,
        state: 'disabled',
        requestedEnabled: false,
        generation: prior.generation + 1,
        nextEvaluationAt: null,
        ...(cancelled ? { lastControlId: null } : {}),
        stopReason: reason,
        blocking: undefined,
        supervision: consumeObsoleteWait(
          prior.supervision ?? startSupervisionProtocol(this.progressKey(sessionId)),
          this.progressKey(sessionId),
        ),
        updatedAt: now,
      },
      cancelled,
    );
    this.cancelTimer(sessionId);
    this.cancelWaitTimer(sessionId);
    this.parkedSubscriptions.delete(sessionId);
  }
  evaluate(sessionId: string): AutopilotSnapshot {
    const prior = this.deps.store.find(sessionId);
    if (!prior) return this.snapshot(sessionId);
    const session = this.deps.session(sessionId);
    const decision = this.decision(sessionId, prior);
    const now = this.deps.now();
    this.deps.diagnostic?.(sessionId, decision.kind);
    let next = prior;
    switch (decision.kind) {
      case 'observe':
        break;
      case 'reconcile':
        next = { ...prior, state: 'monitoring', nextEvaluationAt: null, updatedAt: now };
        if (!this.reconciling.has(sessionId)) {
          this.reconciling.add(sessionId);
          this.enqueue(sessionId, async () => {
            try {
              await this.reconcile(sessionId, prior.generation);
            } finally {
              this.reconciling.delete(sessionId);
            }
          });
        }
        break;
      case 'scheduleContinuation':
        if (session?.activeTurnId || this.deps.pendingInteraction(sessionId)) break;
        if (
          this.deps.executorController &&
          this.deps.plan(sessionId)?.plan &&
          this.currentExecutor(
            sessionId,
            this.deps.plan(sessionId)!.plan,
            prior.consecutiveNoProgress,
            prior.executor,
          )
        ) {
          this.enqueue(sessionId, async () => {
            await this.enforceSupervisedLifecycle(sessionId, 'stateChanged');
          });
          break;
        }
        const existingControl = prior.lastControlId
          ? this.deps.store.findControl(sessionId, prior.lastControlId)
          : null;
        if (existingControl?.status === 'scheduled') {
          const evaluationAt = prior.nextEvaluationAt ?? decision.at;
          if (prior.state !== 'backoff' || prior.nextEvaluationAt !== evaluationAt)
            this.persist({
              ...prior,
              state: 'backoff',
              nextEvaluationAt: evaluationAt,
              updatedAt: now,
            });
          this.arm(sessionId, prior.generation, evaluationAt);
          break;
        }
        const scheduledControlId = this.deps.nextControlId(sessionId, prior.generation);
        next = {
          ...prior,
          state: 'backoff',
          nextEvaluationAt: decision.at,
          lastControlId: scheduledControlId,
          updatedAt: now,
        };
        const control: AutopilotControl = {
          sessionId,
          controlId: scheduledControlId,
          status: 'scheduled',
          createdAt: now,
          updatedAt: now,
          failureCode: null,
          turnId: null,
        };
        // The durable event must describe an actually armed future wake, not
        // merely a control row that is about to receive one.
        this.arm(sessionId, prior.generation, decision.at);
        this.persist(next, control, [
          {
            sessionId,
            type: 'autopilot.continuation-scheduled',
            payload: { controlId: scheduledControlId },
            occurredAt: now,
          },
        ]);
        next = prior;
        break;
      case 'requestAttention': {
        const blocking = this.deps.attention?.(sessionId) ?? undefined;
        if (!validStructuredBlock(blocking)) break;
        next = {
          ...prior,
          state: 'attentionRequired',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: decision.reason,
          blocking,
          updatedAt: now,
        };
        break;
      }
      case 'complete':
        next = {
          ...prior,
          state: 'completed',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: 'planComplete',
          blocking: undefined,
          updatedAt: now,
        };
        break;
      case 'safetyPause':
        next = {
          ...prior,
          state: 'safetyPaused',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: 'safetyPaused',
          updatedAt: now,
        };
        break;
      case 'disable':
        next = {
          ...prior,
          state: 'disabled',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: decision.reason,
          blocking: undefined,
          updatedAt: now,
        };
        break;
    }
    if (
      decision.kind === 'requestAttention' ||
      decision.kind === 'complete' ||
      decision.kind === 'disable' ||
      decision.kind === 'safetyPause'
    )
      this.cancelTimer(sessionId);
    if (next !== prior) {
      const cancelled =
        decision.kind === 'requestAttention' ||
        decision.kind === 'complete' ||
        decision.kind === 'disable' ||
        decision.kind === 'safetyPause'
          ? this.cancelScheduledControl(prior, now)
          : undefined;
      this.persist(cancelled ? { ...next, lastControlId: null } : next, cancelled);
    }
    return this.snapshot(sessionId);
  }
  /** Returns whether an incomplete supervised plan may be treated as terminal by the relay. */
  turnCompleted(sessionId: string): boolean {
    const state = this.deps.store.find(sessionId);
    const plan = this.deps.plan(sessionId)?.plan;
    const explicitlyStopped =
      state?.stopReason === 'manualDisabled' ||
      state?.stopReason === 'planRemoved' ||
      state?.stopReason === 'planReplaced' ||
      state?.stopReason === 'sessionEnded';
    const checkpointBoundary = Boolean(
      state?.checkpoints?.pendingTurnId &&
      state.checkpoints.planIdentity === this.deps.plan(sessionId)?.identity,
    );
    const finalAllowed =
      !state ||
      !plan ||
      explicitlyStopped ||
      checkpointBoundary ||
      (!state.checkpoints && executionComplete(plan)) ||
      validStructuredBlock(state.blocking);
    if (checkpointBoundary && state?.checkpoints) {
      const occurredAt = this.deps.now();
      const pendingKind =
        state.checkpoints.pendingKind ??
        (state.checkpoints.terminalReviewAccepted ? 'terminalReviewAccepted' : 'l1Accepted');
      this.persist(
        {
          ...state,
          // The failure audit is durable history, but it is not a permanent
          // health condition. A matching final or reconstructed runtime has
          // completed the bounded recovery, so clear the live indicator.
          checkpoints: {
            ...state.checkpoints,
            pendingTurnId: null,
            pendingKind: null,
            checkpointHandoffFailed: false,
          },
          updatedAt: occurredAt,
        },
        undefined,
        [
          {
            sessionId,
            type:
              pendingKind === 'l2Completed'
                ? 'org-plan.step-reported'
                : pendingKind === 'terminalReviewAccepted'
                  ? 'org-plan.terminal-review-reported'
                  : 'org-plan.milestone-reported',
            payload: { turnId: state.checkpoints.pendingTurnId },
            occurredAt,
          },
        ],
      );
    }
    if (!finalAllowed) {
      const occurredAt = this.deps.now();
      this.commit({
        events: [
          {
            sessionId,
            type: 'autopilot.final-rejected',
            payload: { reason: 'incompletePlan' },
            occurredAt,
          },
        ],
      });
      this.flushOutbox(sessionId);
    }
    // The persisted checkpoint is the continuation trigger. It becomes
    // actionable only after the root final has closed its owning turn.
    if (checkpointBoundary) this.evaluate(sessionId);
    else this.activitySettled(sessionId, 'rootFinalAttempt');
    return finalAllowed;
  }
  /** Records an already validated root-only checkpoint; it never changes Org state. */
  checkpointAccepted(
    sessionId: string,
    checkpoint: OrgPlanCheckpoint,
    turnId: string | null,
    occurredAt: string,
  ): boolean {
    const prior = this.deps.store.find(sessionId);
    const retained = this.deps.plan(sessionId);
    if (!prior || !retained || !turnId || checkpoint.planIdentity !== retained.identity)
      return false;
    const previous = prior.checkpoints;
    if (previous && previous.planIdentity !== retained.identity) return false;
    const reportedL1Ids = previous?.reportedL1Ids ?? [];
    const reportedL2Ids = previous?.reportedL2Ids ?? [];
    const canonicalPosition =
      checkpoint.kind === 'terminalReviewAccepted' ? 'terminal' : checkpoint.position;
    const target =
      checkpoint.kind === 'l2Completed'
        ? checkpointTarget('l2', checkpoint.l1Id, checkpoint.l2Id)
        : checkpoint.kind === 'l1Accepted'
          ? checkpointTarget('l1', checkpoint.l1Id)
          : checkpointTarget('terminal');
    const completionEpoch = previous?.completionEpochs?.find((entry) => entry.target === target);
    const epoch = completionEpoch?.epoch ?? 0;
    const key = createHash('sha256')
      .update(JSON.stringify([retained.identity, checkpoint.kind, canonicalPosition, epoch]))
      .digest('hex');
    const acceptedKeys = previous?.acceptedKeys ?? [];
    if (acceptedKeys.includes(key))
      return previous?.pendingTurnId === turnId && previous.pendingKind === checkpoint.kind;
    const l2Key =
      checkpoint.kind === 'l2Completed' ? JSON.stringify([checkpoint.l1Id, checkpoint.l2Id]) : null;
    if (checkpoint.kind === 'terminalReviewAccepted' && previous?.terminalReviewAccepted)
      return false;
    if (completionEpoch?.completed && !completionEpoch.reopened) return false;
    const completionEpochs = [
      ...(previous?.completionEpochs ?? []).filter((entry) => entry.target !== target),
      { target, epoch, reopened: false, completed: true },
    ];
    const checkpoints = {
      protocolVersion: 1 as const,
      planIdentity: retained.identity,
      completionEpochs: boundEpochs(completionEpochs, target),
      reportedL2Ids: l2Key ? boundedUnique([...reportedL2Ids, l2Key], 512) : reportedL2Ids,
      reportedL1Ids:
        checkpoint.kind === 'l1Accepted'
          ? boundedUnique([...reportedL1Ids, checkpoint.l1Id], 128)
          : reportedL1Ids,
      acceptedKeys: boundedUnique([...acceptedKeys, key], 768),
      pendingTurnId: turnId,
      pendingKind: checkpoint.kind,
      checkpointHandoffFailed: false,
      terminalReviewAccepted:
        checkpoint.kind === 'terminalReviewAccepted' || previous?.terminalReviewAccepted === true,
    };
    const checkpointed = { ...prior, checkpoints, updatedAt: occurredAt };
    this.persist(
      {
        ...checkpointed,
        supervision: checkpointed.supervision
          ? consumeCheckpointBoundary(
              checkpointed.supervision,
              this.progressKeyFor(sessionId, checkpointed, retained),
            )
          : checkpointed.supervision,
      },
      undefined,
      [
        {
          sessionId,
          type:
            checkpoint.kind === 'l2Completed'
              ? 'org-plan.step-checkpointed'
              : checkpoint.kind === 'l1Accepted'
                ? 'org-plan.milestone-checkpointed'
                : 'org-plan.terminal-review-checkpointed',
          payload:
            checkpoint.kind === 'l2Completed'
              ? {
                  l1Id: checkpoint.l1Id,
                  l2Id: checkpoint.l2Id,
                  position: checkpoint.position,
                  turnId,
                }
              : checkpoint.kind === 'l1Accepted'
                ? { l1Id: checkpoint.l1Id, position: checkpoint.position, turnId }
                : { turnId },
          occurredAt,
        },
      ],
    );
    // Persistence and acknowledgement stay on the short checkpoint path. Any
    // pre-boundary lease is already obsolete, but continuation is deliberately
    // deferred until the matching root final closes the turn.
    this.cancelWaitTimer(sessionId);
    this.parkedSubscriptions.delete(sessionId);
    this.cancelTimer(sessionId);
    return true;
  }
  /**
   * Records a failed checkpoint transport handoff without releasing its root
   * boundary. The matching final (or a runtime recovery) remains the only
   * authority allowed to schedule the next root continuation.
   */
  checkpointHandoffFailed(sessionId: string, requestTurnId: string | null): boolean {
    const prior = this.deps.store.find(sessionId);
    if (
      !prior?.checkpoints?.pendingTurnId ||
      prior.checkpoints.pendingTurnId !== requestTurnId ||
      prior.checkpoints.checkpointHandoffFailed
    )
      return false;
    this.persist({
      ...prior,
      checkpoints: { ...prior.checkpoints, checkpointHandoffFailed: true },
      updatedAt: this.deps.now(),
    });
    return true;
  }
  /** A replacement runtime is the explicit substitute for the lost root final. */
  recoverCheckpointHandoff(sessionId: string): boolean {
    const pendingTurnId = this.deps.store.find(sessionId)?.checkpoints?.pendingTurnId;
    if (!pendingTurnId) return false;
    this.checkpointHandoffFailed(sessionId, pendingTurnId);
    return this.turnCompleted(sessionId);
  }
  /** Handles only plan lifecycle safety; ordinary plan mutations are ignored. */
  planStatusChanged(sessionId: string): void {
    const prior = this.deps.store.find(sessionId);
    if (!prior?.requestedEnabled) return;
    const plan = this.deps.plan(sessionId);
    if (!plan) {
      this.cancel(sessionId, 'planRemoved');
      return;
    }
    if (prior.planIdentity && prior.planIdentity !== plan.identity) {
      this.supersedeExecutorCommands(sessionId, plan.identity, plan.plan);
      this.cancel(sessionId, 'planReplaced');
      return;
    }
    this.supersedeExecutorCommands(sessionId, plan.identity, plan.plan);
    // Supersession persists independently. Re-read before reopening epochs so
    // this update cannot restore commands from the stale pre-supersession row.
    const current = this.deps.store.find(sessionId) ?? prior;
    const checkpointEpochs = this.reopenCheckpointEpochs(current, plan.plan);
    if (checkpointEpochs !== current.checkpoints?.completionEpochs)
      this.persist({
        ...current,
        checkpoints: { ...current.checkpoints!, completionEpochs: checkpointEpochs },
        updatedAt: this.deps.now(),
      });
    if (
      this.semanticEvent(sessionId, 'planChanged') ||
      this.semanticEvent(sessionId, 'reviewChanged')
    )
      return;
    // Plan and review changes are mandatory lifecycle inputs, not merely a
    // completion detector.  A parked lease consumes the event above; without
    // one, directly evaluate so an accepted L1 or a partial transition cannot
    // strand the root waiting for unrelated activity.
    const eventKey = `plan:${fingerprint(plan.plan)}`;
    if (this.planEventKeys.get(sessionId) === eventKey) return;
    this.planEventKeys.set(sessionId, eventKey);
    this.evaluate(sessionId);
  }

  /**
   * Plan refinements are not a new completion.  Only a completed target that
   * becomes ineligible opens its next reportable epoch.
   */
  private reopenCheckpointEpochs(
    state: AutopilotSession,
    plan: SupervisedPlan,
  ):
    | readonly Readonly<{ target: string; epoch: number; reopened: boolean; completed: boolean }>[]
    | undefined {
    const epochs = state.checkpoints?.completionEpochs;
    if (!epochs?.length) return epochs;
    let changed = false;
    const next = epochs.map((entry) => {
      const [kind, l1Id, l2Id] = JSON.parse(entry.target) as string[];
      const l1 = plan.steps.find((step) => step.id === l1Id);
      const eligible =
        kind === 'l2'
          ? Boolean(l1?.children.some((child) => child.id === l2Id && child.state === 'DONE'))
          : kind === 'l1'
            ? l1?.state === 'DONE' && l1.reviewStatus === 'REVIEWED'
            : plan.executionComplete === true;
      if (!eligible && !entry.reopened) {
        changed = true;
        return { ...entry, epoch: entry.epoch + 1, reopened: true, completed: false };
      }
      return entry;
    });
    return changed ? next : epochs;
  }
  /**
   * Records a validated, session-private supervision request.  It intentionally
   * does not discover plans: composition must first bind the update to this
   * relay session.  A manual Off is authoritative for the retained identity,
   * while a new identity can receive its own explicit supervision request.
   */
  supervisionStarted(sessionId: string): AutopilotSnapshot | { code: string } {
    const currentPlan = this.deps.plan(sessionId);
    if (!currentPlan) return { code: 'AUTOPILOT_PLAN_REQUIRED' };
    if (executionComplete(currentPlan.plan)) return { code: 'AUTOPILOT_PLAN_COMPLETE' };
    const now = this.deps.now();
    const prior = this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, now);
    if (
      prior.planIdentity === currentPlan.identity &&
      !prior.requestedEnabled &&
      prior.stopReason === 'manualDisabled'
    )
      return this.snapshot(sessionId);
    if (prior.requestedEnabled && prior.planIdentity === currentPlan.identity)
      return this.snapshot(sessionId);

    const replacing = Boolean(prior.planIdentity && prior.planIdentity !== currentPlan.identity);
    const cancelled = replacing ? this.cancelScheduledControl(prior, now) : undefined;
    if (replacing) {
      this.cancelTimer(sessionId);
      this.cancelWaitTimer(sessionId);
      this.parkedSubscriptions.delete(sessionId);
    }
    const next: AutopilotSession = {
      ...prior,
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: currentPlan.identity,
      planFingerprint: fingerprint(currentPlan.plan),
      generation: prior.generation + 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      ...(cancelled ? { lastControlId: null } : {}),
      stopReason: null,
      executor: undefined,
      blocking: undefined,
      supervision: recoverSafetyPause(
        consumeObsoleteWait(
          replacing
            ? startSupervisionProtocol(this.progressKey(sessionId))
            : (prior.supervision ?? startSupervisionProtocol(this.progressKey(sessionId))),
          this.progressKey(sessionId),
        ),
        this.progressKey(sessionId),
      ),
      updatedAt: now,
    };
    this.persist(next, cancelled);
    const session = this.deps.session(sessionId);
    if (session?.threadId && ['ready', 'turnActive'].includes(session.state))
      this.evaluate(sessionId);
    return this.snapshot(sessionId);
  }
  /** Reacts only to fresh actor status; plan mutations are not scheduling signals. */
  activityChanged(sessionId: string): void {
    const prior = this.deps.store.find(sessionId);
    if (!prior?.requestedEnabled) return;
    const activity = this.deps.activity(sessionId);
    // A stale or absent activity projection is itself a mandatory wake input.
    // Do not require a probe lease to restore the authoritative topology.
    if (!activity || activity.confidence !== 'fresh') {
      this.evaluate(sessionId);
      return;
    }
    // Reuse the canonical semantic projection: child order, timestamps, and
    // activity prose cannot manufacture an extra wake, while a child-only
    // lifecycle transition remains visible with an unchanged root.
    const eventKey = this.progressKey(sessionId);
    if (this.activityEventKeys.get(sessionId) === eventKey) return;
    this.activityEventKeys.set(sessionId, eventKey);
    if (this.semanticEvent(sessionId, 'agentActivityChanged')) return;
    const disposition = classifyAgentActivity(activity);
    if (disposition === 'attention') {
      this.evaluate(sessionId);
      return;
    }
    if (disposition === 'reconcile') {
      this.evaluate(sessionId);
      return;
    }
    if (disposition === 'active') {
      this.cancelTimer(sessionId);
      const now = this.deps.now();
      const cancelled = this.cancelScheduledControl(prior, now);
      const subagentsWorking =
        activity.aggregateSubagents === 'working' ||
        activity.aggregateSubagents === 'awaitingAgent';
      if (
        cancelled ||
        prior.state !== 'monitoring' ||
        prior.nextEvaluationAt ||
        (subagentsWorking && prior.consecutiveNoProgress > 0)
      )
        this.persist(
          {
            ...prior,
            state: 'monitoring',
            ...(cancelled ? { generation: prior.generation + 1, lastControlId: null } : {}),
            ...(subagentsWorking ? { consecutiveNoProgress: 0 } : {}),
            nextEvaluationAt: null,
            updatedAt: now,
          },
          cancelled,
        );
      return;
    }
    if (disposition === 'settled') this.activitySettled(sessionId, 'stateChanged');
  }
  activitySettled(sessionId: string, event: SupervisedLifecycleEvent = 'stateChanged'): void {
    const prior = this.deps.store.find(sessionId);
    if (!prior?.requestedEnabled || prior.state !== 'monitoring') return;
    this.completionTimers.get(sessionId)?.();
    this.completionTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.completionTimers.delete(sessionId);
        this.enqueue(sessionId, async () => {
          const current = this.deps.store.find(sessionId);
          if (!current?.requestedEnabled || current.state !== 'monitoring') return;
          if (!(await this.enforceSupervisedLifecycle(sessionId, event))) this.evaluate(sessionId);
        });
      }, this.deps.policy.quiescenceMs),
    );
  }
  manualSend(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.cancelWaitTimer(sessionId);
    this.parkedSubscriptions.delete(sessionId);
    const prior = this.deps.store.find(sessionId);
    if (!prior || !prior.requestedEnabled) return;
    const now = this.deps.now();
    const cancelled = this.cancelScheduledControl(prior, now);
    this.persist(
      {
        ...prior,
        state: 'monitoring',
        generation: prior.generation + 1,
        nextEvaluationAt: null,
        lastControlId: null,
        supervision: consumeObsoleteWait(
          prior.supervision ?? startSupervisionProtocol(this.progressKey(sessionId)),
          this.progressKey(sessionId),
        ),
        updatedAt: now,
      },
      cancelled,
    );
  }
  recordControlIssued(sessionId: string, controlId: string): boolean {
    const prior = this.deps.store.find(sessionId);
    if (
      !prior ||
      !prior.requestedEnabled ||
      prior.lastControlId !== controlId ||
      prior.state !== 'backoff'
    )
      return false;
    const now = this.deps.now();
    const next: AutopilotSession = {
      ...prior,
      lastControlId: controlId,
      state: 'monitoring',
      nextEvaluationAt: null,
      consecutiveNoProgress: prior.consecutiveNoProgress + 1,
      updatedAt: now,
    };
    const priorControl = this.deps.store.findControl(sessionId, controlId);
    if (!priorControl || priorControl.status !== 'scheduled') return false;
    const issuedControl = { ...priorControl, status: 'issued' as const, updatedAt: now };
    const events = [
      ...this.snapshotEvents(next, issuedControl),
      { sessionId, type: 'autopilot.control-issued', payload: { controlId }, occurredAt: now },
    ];
    const control = this.deps.store.claimControlIssued
      ? this.deps.store.claimControlIssued(sessionId, controlId, now, next, events)
      : this.legacyClaim(sessionId, controlId, next, events);
    if (!control) return false;
    this.publishedSnapshots.set(sessionId, this.semanticSnapshot(next, control));
    this.flushOutbox(sessionId);
    return true;
  }
  private persist(
    next: AutopilotSession,
    control?: AutopilotControl,
    events: readonly AutopilotAuditEvent[] = [],
  ): void {
    const snapshotEvents = this.snapshotEvents(next, control);
    this.commit({
      state: next,
      ...(control ? { control } : {}),
      events: [...snapshotEvents, ...events],
    });
    if (snapshotEvents.length)
      this.publishedSnapshots.set(next.sessionId, this.semanticSnapshot(next, control));
    this.flushOutbox(next.sessionId);
  }
  private arm(sessionId: string, generation: number, at: string): void {
    this.cancelTimer(sessionId);
    this.timers.set(
      sessionId,
      this.deps.schedule(
        () => this.enqueue(sessionId, () => this.fire(sessionId, generation)),
        Math.max(0, Date.parse(at) - Date.parse(this.deps.now())),
      ),
    );
  }
  private async fire(sessionId: string, generation: number): Promise<void> {
    this.timers.delete(sessionId);
    const current = this.deps.store.find(sessionId);
    if (!current || current.generation !== generation || !current.requestedEnabled) return;
    if (
      current.executor?.replacement &&
      !this.validReplacement(sessionId, current.executor.replacement)
    ) {
      const now = this.deps.now();
      const cancelled = this.cancelScheduledControl(current, now);
      this.persist(
        {
          ...current,
          state: 'monitoring',
          executor: {
            ...current.executor,
            replacement: undefined,
            commands: current.executor.commands?.map((command) =>
              ['scheduled', 'issued'].includes(command.status)
                ? { ...command, status: 'superseded' as const, updatedAt: now }
                : command,
            ),
          },
          ...(cancelled ? { generation: current.generation + 1, lastControlId: null } : {}),
          nextEvaluationAt: null,
          updatedAt: now,
        },
        cancelled,
      );
      this.audit(sessionId, 'autopilot.executor-replacement-superseded', {});
      this.evaluate(sessionId);
      return;
    }
    const session = this.deps.session(sessionId);
    if (
      session?.activeTurnId ||
      this.deps.pendingInteraction(sessionId) ||
      this.decision(sessionId, current).kind !== 'scheduleContinuation'
    ) {
      const now = this.deps.now();
      const cancelled = this.cancelScheduledControl(current, now);
      this.persist(
        {
          ...current,
          state: 'monitoring',
          ...(cancelled ? { generation: current.generation + 1, lastControlId: null } : {}),
          nextEvaluationAt: null,
          updatedAt: now,
        },
        cancelled,
      );
      this.evaluate(sessionId);
      return;
    }
    const retained = this.deps.plan(sessionId);
    if (
      this.deps.executorController &&
      retained &&
      !current.executor?.replacement &&
      this.currentExecutor(
        sessionId,
        retained.plan,
        current.consecutiveNoProgress,
        current.executor,
      )
    ) {
      const now = this.deps.now();
      const cancelled = this.cancelScheduledControl(current, now);
      this.persist(
        {
          ...current,
          state: 'monitoring',
          generation: current.generation + 1,
          nextEvaluationAt: null,
          lastControlId: null,
          updatedAt: now,
        },
        cancelled,
      );
      await this.enforceSupervisedLifecycle(sessionId, 'stateChanged');
      return;
    }
    const protocol = recordAutomaticContinuation(
      current.supervision ?? startSupervisionProtocol(this.progressKey(sessionId)),
      this.progressKey(sessionId),
    );
    if (protocol.outcome === 'probeRequired') {
      this.persist({ ...current, supervision: protocol, updatedAt: this.deps.now() }, undefined, [
        {
          sessionId,
          type: 'autopilot.probe-required',
          payload: { progressKey: protocol.progressKey },
          occurredAt: this.deps.now(),
        },
      ]);
    }
    if (protocol.outcome === 'safetyPaused') {
      const now = this.deps.now();
      const cancelled = this.cancelScheduledControl(current, now);
      this.persist(
        {
          ...current,
          state: 'safetyPaused',
          requestedEnabled: false,
          stopReason: 'safetyPaused',
          ...(cancelled ? { generation: current.generation + 1, lastControlId: null } : {}),
          nextEvaluationAt: null,
          supervision: protocol,
          updatedAt: now,
        },
        cancelled,
        [
          {
            sessionId,
            type: 'autopilot.safety-paused',
            payload: { progressKey: protocol.progressKey },
            occurredAt: now,
          },
        ],
      );
      return;
    }
    const id = current.lastControlId;
    if (!id) return;
    if (!this.recordControlIssued(sessionId, id)) return;
    try {
      await this.deps.turnStarter.start(
        sessionId,
        id,
        generation,
        this.freshExecutorIdentity(sessionId),
      );
      this.updateControl(
        sessionId,
        id,
        'started',
        null,
        this.deps.session(sessionId)?.activeTurnId ?? null,
        'autopilot.turn-started',
      );
    } catch (error) {
      // The runtime persists an accepted turn before returning to this coordinator.
      // A process-loss/fault seam after that durability point is not a failed start:
      // promote the existing control and let its outbox audit replay exactly once.
      const acceptedTurnId = this.deps.session(sessionId)?.activeTurnId;
      if (acceptedTurnId) {
        this.updateControl(
          sessionId,
          id,
          'started',
          null,
          acceptedTurnId,
          'autopilot.turn-started',
        );
        return;
      }
      const failureCode = startFailureCode(error);
      this.updateControl(sessionId, id, 'failed', failureCode, null, 'autopilot.turn-failed');
      // A transport/runtime failure is not a decision-table blocker. Keep the
      // supervised lifecycle active and re-inspect explicit runtime state.
      if (failureCode === 'START_UNAVAILABLE') {
        const latest = this.deps.store.find(sessionId);
        if (latest?.requestedEnabled)
          this.persist({
            ...latest,
            state: 'monitoring',
            generation: latest.generation + 1,
            nextEvaluationAt: null,
            stopReason: 'startUnavailable',
            updatedAt: this.deps.now(),
          });
        this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
        return;
      }
      this.evaluate(sessionId);
    }
  }
  private cancelTimer(sessionId: string): void {
    this.timers.get(sessionId)?.();
    this.timers.delete(sessionId);
    this.completionTimers.get(sessionId)?.();
    this.completionTimers.delete(sessionId);
    this.executorTimers.get(sessionId)?.();
    this.executorTimers.delete(sessionId);
    const state = this.deps.store.find(sessionId);
    const executor = state?.executor;
    if (state && executor?.commands?.some((command) => command.status === 'scheduled'))
      this.persist({
        ...state,
        executor: {
          ...executor,
          commands: executor.commands.map((command) =>
            command.status === 'scheduled'
              ? { ...command, status: 'cancelled' as const, updatedAt: this.deps.now() }
              : command,
          ),
        },
        updatedAt: this.deps.now(),
      });
  }

  private cancelWaitTimer(sessionId: string): void {
    this.waitTimers.get(sessionId)?.();
    this.waitTimers.delete(sessionId);
  }

  private armWaitDeadline(sessionId: string, leaseId: string, resumeAt: string): void {
    this.cancelWaitTimer(sessionId);
    this.waitTimers.set(
      sessionId,
      this.deps.schedule(
        () => {
          this.waitTimers.delete(sessionId);
          const state = this.deps.store.find(sessionId);
          if (!state?.requestedEnabled || !state.supervision) return;
          const lease = state.supervision.waitLease;
          if (
            state.supervision.outcome !== 'parked' ||
            !lease ||
            lease.id !== leaseId ||
            lease.resumeAt !== resumeAt
          )
            return;
          const protocol = consumeWaitDeadline(state.supervision, leaseId, this.deps.now());
          if (protocol === state.supervision) {
            this.armWaitDeadline(sessionId, leaseId, resumeAt);
            return;
          }
          this.parkedSubscriptions.delete(sessionId);
          this.persist({ ...state, supervision: protocol, updatedAt: this.deps.now() });
          this.evaluate(sessionId);
        },
        Math.max(0, Date.parse(resumeAt) - Date.parse(this.deps.now())),
      ),
    );
  }

  private async enforceSupervisedLifecycle(
    sessionId: string,
    event: SupervisedLifecycleEvent,
  ): Promise<boolean> {
    const controller = this.deps.executorController;
    const retained = this.deps.plan(sessionId);
    const state = this.deps.store.find(sessionId);
    if (
      !controller ||
      !retained ||
      !state?.requestedEnabled ||
      this.deps.pendingInteraction(sessionId)
    )
      return false;
    const executor = this.currentExecutor(
      sessionId,
      retained.plan,
      state.consecutiveNoProgress,
      state.executor,
    );
    const executorChanged = executor ? this.persistExecutor(sessionId, executor) : false;
    if (executor && (await this.reconcileSplitBrain(sessionId, executor))) return true;
    if (executor)
      this.supersedeExecutorCommands(sessionId, retained.identity, retained.plan, executor);
    if (executorChanged && this.wakeForExecutorChange(sessionId, executor!)) return true;
    const decision = decideSupervisedLifecycle({
      plan: retained.plan,
      event,
      ...(executor ? { executor } : {}),
      now: this.deps.now(),
      policy: {
        continuationBaseDelayMs: this.deps.policy.executorContinuationBaseMs,
        continuationMaxDelayMs: this.deps.policy.executorContinuationMaxMs,
        processPollMs: this.deps.policy.processPollMs,
        processMaxElapsedMs: this.deps.policy.processMaxElapsedMs,
        processMaxRssBytes: this.deps.policy.processMaxRssBytes,
      },
    });
    switch (decision.action.kind) {
      case 'allowFinal':
      case 'invokeAttention':
      case 'continueSupervisor':
      case 'reinspect':
        return false;
      case 'resumeExecutor':
        this.armExecutorContinuation(
          sessionId,
          decision.action.delayMs,
          decision.action.threadId,
          decision.action.generation,
          { kind: 'partial' },
        );
        return true;
      case 'monitorProcess': {
        const processId = decision.action.process.processId;
        const alreadyMonitoring = executor?.ownedProcesses.some(
          (process) =>
            process.processId === processId &&
            process.ownership === 'supervisor' &&
            process.state === 'detached-active',
        );
        const transferred =
          alreadyMonitoring || !executor
            ? alreadyMonitoring
            : await this.performProcessAction(
                sessionId,
                executor,
                decision.action.process,
                'transfer',
              );
        if (transferred && !alreadyMonitoring)
          this.audit(sessionId, 'autopilot.process-monitoring', {
            threadId: decision.action.process.ownerThreadId,
            processId,
          });
        this.armExecutorRefresh(sessionId, decision.action.pollAfterMs);
        return true;
      }
      case 'consumeProcessResult': {
        const processAction = decision.action;
        const processId = processAction.processId;
        const process = executor?.ownedProcesses.find(
          (candidate) =>
            candidate.processId === processId &&
            candidate.ownerThreadId === processAction.threadId &&
            candidate.state === 'exited-awaiting-result',
        );
        const consumed =
          process && executor
            ? await this.performProcessAction(sessionId, executor, process, 'consume')
            : false;
        if (consumed)
          this.audit(sessionId, 'autopilot.process-result-consumed', {
            threadId: processAction.threadId,
            processId,
            resultArtifact: processAction.resultArtifact,
          });
        if (consumed && executor)
          this.armExecutorContinuation(
            sessionId,
            this.deps.policy.executorContinuationBaseMs,
            executor.threadId,
            executor.continuationGeneration + 1,
            {
              kind: 'processExited',
              processId,
              resultArtifact: processAction.resultArtifact,
            },
          );
        return true;
      }
      case 'terminateProcess': {
        const processAction = decision.action;
        const processId = processAction.processId;
        const process = executor?.ownedProcesses.find(
          (candidate) =>
            candidate.processId === processId && candidate.ownerThreadId === processAction.threadId,
        );
        const terminated =
          process && executor
            ? await this.performProcessAction(sessionId, executor, process, 'terminate')
            : false;
        if (terminated)
          this.audit(sessionId, 'autopilot.process-terminated', {
            threadId: processAction.threadId,
            processId,
            reason: 'resourceBudget',
          });
        if (terminated && executor)
          this.armExecutorContinuation(
            sessionId,
            this.deps.policy.executorContinuationBaseMs,
            executor.threadId,
            executor.continuationGeneration + 1,
            { kind: 'processResourceLimit', processId },
          );
        else this.armExecutorRefresh(sessionId, this.deps.policy.processPollMs);
        return true;
      }
    }
  }

  private currentExecutor(
    sessionId: string,
    plan: SupervisedPlan,
    continuationCount: number,
    persisted?: ExecutorLifecycle,
  ): ExecutorLifecycle | undefined {
    const stepIndex = plan.steps.findIndex(
      (step) => step.id === plan.currentStepId || step.state === 'WIP',
    );
    const index =
      stepIndex >= 0 ? stepIndex : plan.steps.findIndex((step) => step.state !== 'DONE');
    if (index < 0) return undefined;
    const step = plan.steps[index]!;
    const canonicalPosition = `L${index + 1}`;
    const child = this.deps
      .activity(sessionId)
      ?.subagents.filter((candidate) => candidate.canonicalPosition === canonicalPosition)
      .sort(
        (left, right) =>
          (right.continuationGeneration ?? 1) - (left.continuationGeneration ?? 1) ||
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
          (left.threadId ?? left.id).localeCompare(right.threadId ?? right.id),
      )[0];
    if (!child) {
      if (
        persisted?.canonicalPosition !== canonicalPosition ||
        persisted.outcome === 'cancelled' ||
        persisted.outcome === 'failed'
      )
        return undefined;
      return {
        ...persisted,
        l1State: step.state,
        continuationCount: persisted.continuationCount,
        ownedProcesses: refreshPersistedProcesses(persisted.ownedProcesses, [], this.deps.now()),
      };
    }
    // A roster entry for a newer generation is authoritative even when that
    // generation is disconnected. Never fall back to an older persisted
    // writer; incomplete owner metadata instead fences all continuation.
    if (!child.taskPath || !child.canonicalTaskName) return undefined;
    if (child.outcome === 'cancelled' || child.outcome === 'failed') return undefined;
    const activeL2 = step.children.find((candidate) => candidate.state === 'WIP');
    const outcome = classifyExecutorOutcome({
      objectiveComplete: step.state === 'DONE',
      reportedOutcome: child.outcome,
    });
    return {
      canonicalPosition,
      canonicalTaskName: child.canonicalTaskName,
      taskPath: child.taskPath,
      threadId: child.threadId ?? child.id,
      l1State: step.state,
      ...(activeL2 ? { l2State: activeL2.state } : {}),
      lastActivityAt: child.lastActivityAt,
      ownedProcesses: refreshPersistedProcesses(
        persisted?.canonicalPosition === canonicalPosition ? persisted.ownedProcesses : [],
        child.ownedProcesses ?? [],
        this.deps.now(),
      ),
      outcome: outcome.outcome,
      ...(outcome.blocking ? { blocking: outcome.blocking } : {}),
      continuationGeneration: Math.max(
        child.continuationGeneration ?? 1,
        persisted?.canonicalPosition === canonicalPosition ? persisted.continuationGeneration : 1,
      ),
      continuationCount:
        persisted?.canonicalPosition === canonicalPosition
          ? persisted.continuationCount
          : continuationCount,
      ...(persisted?.replacement &&
      (child.continuationGeneration ?? 1) < persisted.replacement.generation
        ? { replacement: persisted.replacement }
        : {}),
      ...(persisted?.replacement &&
      (child.continuationGeneration ?? 1) >= persisted.replacement.generation
        ? { resumeFailures: 0 }
        : persisted?.resumeFailures
          ? { resumeFailures: persisted.resumeFailures }
          : {}),
      ...(persisted?.commands ? { commands: persisted.commands } : {}),
    };
  }

  /** A fresh roster may expose two physical writers for one canonical L1. */
  private async reconcileSplitBrain(
    sessionId: string,
    executor: ExecutorLifecycle,
  ): Promise<boolean> {
    const activity = this.deps.activity(sessionId);
    if (activity?.confidence !== 'fresh') return true;
    const candidates = activity.subagents.filter(
      (child) => child.canonicalPosition === executor.canonicalPosition,
    );
    if (candidates.length < 2) return false;
    if (
      candidates.some(
        (child) =>
          !child.threadId ||
          !child.taskPath ||
          child.canonicalTaskName !== executor.canonicalTaskName ||
          child.continuationGeneration === undefined,
      )
    ) {
      this.audit(sessionId, 'autopilot.executor-reconciliation-incomplete', {});
      return true;
    }
    const ordered = [...candidates].sort(
      (left, right) =>
        (right.continuationGeneration ?? 0) - (left.continuationGeneration ?? 0) ||
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
        (left.threadId ?? left.id).localeCompare(right.threadId ?? right.id),
    );
    const owner = ordered[0]!;
    const obsolete = ordered
      .slice(1)
      .filter(
        (child) =>
          child.state === 'working' ||
          child.state === 'awaitingAgent' ||
          child.ownedProcesses?.some(
            (process) => process.state === 'running' || process.state === 'detached-active',
          ),
      );
    const controller = this.deps.executorController;
    const ownerUnavailable =
      owner.state === 'disconnected' || owner.outcome === 'cancelled' || owner.outcome === 'failed';
    if (!obsolete.length) {
      if (!ownerUnavailable) return false;
      if (controller) await controller.refresh(sessionId);
      return true;
    }
    if (!controller) return true;
    for (const child of obsolete) {
      try {
        const interrupted = await controller.interrupt(sessionId, child.threadId!);
        this.audit(
          sessionId,
          interrupted ? 'autopilot.executor-superseded' : 'autopilot.executor-interrupt-failed',
          {
            ownerThreadId: owner.threadId,
            obsoleteThreadId: child.threadId,
          },
        );
      } catch {
        this.audit(sessionId, 'autopilot.executor-interrupt-failed', {
          ownerThreadId: owner.threadId,
          obsoleteThreadId: child.threadId,
        });
      }
    }
    await controller.refresh(sessionId);
    return true;
  }

  private executorCommand(
    fence: Readonly<{
      planIdentity: string;
      planFingerprint: string;
      canonicalPosition: string | null;
      executorThreadId: string;
      executorGeneration: number;
    }>,
    executor: ExecutorLifecycle,
    generation: number,
    trigger: Parameters<NonNullable<AutopilotDependencies['executorController']>['resume']>[3],
  ): ExecutorCommand {
    const commandId = createHash('sha256')
      .update(
        JSON.stringify([
          fence.planIdentity,
          fence.planFingerprint,
          fence.canonicalPosition,
          executor.canonicalTaskName,
          executor.taskPath,
          fence.executorThreadId,
          generation,
          ...(executor.resumeFailures ? [executor.resumeFailures] : []),
          trigger.kind,
        ]),
      )
      .digest('hex');
    const now = this.deps.now();
    return {
      commandId,
      status: 'scheduled',
      planIdentity: fence.planIdentity,
      planFingerprint: fence.planFingerprint,
      canonicalPosition: fence.canonicalPosition ?? executor.canonicalPosition,
      canonicalTaskName: executor.canonicalTaskName,
      taskPath: executor.taskPath,
      threadId: fence.executorThreadId,
      generation,
      ...(executor.resumeFailures ? { attempt: executor.resumeFailures } : {}),
      trigger: trigger.kind,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Process actions share the durable executor-command journal but carry a process-instance key. */
  private processActionCommand(
    sessionId: string,
    executor: ExecutorLifecycle,
    process: OwnedExecutorProcess,
    kind: 'transfer' | 'consume' | 'terminate',
  ): ExecutorCommand {
    const retained = this.deps.plan(sessionId);
    const processKey = executorProcessKey(process);
    const now = this.deps.now();
    return {
      commandId: createHash('sha256')
        .update(
          JSON.stringify([
            retained?.identity ?? 'none',
            retained ? fingerprint(retained.plan) : 'none',
            executor.canonicalPosition,
            executor.canonicalTaskName,
            executor.taskPath,
            executor.threadId,
            executor.continuationGeneration,
            kind,
            processKey,
          ]),
        )
        .digest('hex'),
      status: 'scheduled',
      planIdentity: retained?.identity ?? 'none',
      planFingerprint: retained ? fingerprint(retained.plan) : 'none',
      canonicalPosition: executor.canonicalPosition,
      canonicalTaskName: executor.canonicalTaskName,
      taskPath: executor.taskPath,
      threadId: executor.threadId,
      generation: executor.continuationGeneration,
      // Process work never launches a writer itself; this preserves the command
      // envelope without conflating it with a continuation prompt.
      trigger: 'partial',
      processAction: { kind, processKey },
      createdAt: now,
      updatedAt: now,
    };
  }

  private processActionCurrent(
    sessionId: string,
    command: ExecutorCommand,
  ): {
    state: AutopilotSession;
    executor: ExecutorLifecycle;
    process: OwnedExecutorProcess;
  } | null {
    const state = this.deps.store.find(sessionId);
    const retained = this.deps.plan(sessionId);
    const executor = state?.executor;
    const child = this.deps
      .activity(sessionId)
      ?.subagents.find((candidate) => (candidate.threadId ?? candidate.id) === command.threadId);
    if (
      !state?.requestedEnabled ||
      !retained ||
      !executor ||
      !command.processAction ||
      retained.identity !== command.planIdentity ||
      fingerprint(retained.plan) !== command.planFingerprint ||
      executor.canonicalPosition !== command.canonicalPosition ||
      executor.canonicalTaskName !== command.canonicalTaskName ||
      executor.taskPath !== command.taskPath ||
      executor.threadId !== command.threadId ||
      executor.continuationGeneration !== command.generation ||
      child?.canonicalPosition !== command.canonicalPosition ||
      child?.canonicalTaskName !== command.canonicalTaskName ||
      (child.continuationGeneration ?? 1) !== command.generation
    )
      return null;
    const process = executor.ownedProcesses.find(
      (candidate) => executorProcessKey(candidate) === command.processAction!.processKey,
    );
    return process ? { state, executor, process } : null;
  }

  /**
   * Records issued before crossing the external boundary. Repeating an issued
   * action passes the same command id to an idempotent adapter, so a process
   * loss after the external effect cannot duplicate ownership or consumption.
   */
  private async performProcessAction(
    sessionId: string,
    executor: ExecutorLifecycle,
    process: OwnedExecutorProcess,
    kind: 'transfer' | 'consume' | 'terminate',
  ): Promise<boolean> {
    const controller = this.deps.executorController;
    if (!controller) return false;
    const requested = this.processActionCommand(sessionId, executor, process, kind);
    const command = this.scheduleExecutorCommand(sessionId, requested);
    if (!command || ['cancelled', 'superseded'].includes(command.status)) return false;
    if (command.status === 'accepted') return true;
    const current = this.processActionCurrent(sessionId, command);
    if (!current) {
      this.executorCommandTransition(sessionId, command.commandId, 'superseded');
      return false;
    }
    const issued =
      command.status === 'issued'
        ? command
        : this.executorCommandTransition(sessionId, command.commandId, 'issued');
    if (!issued || issued.status !== 'issued') return false;
    try {
      const accepted =
        kind === 'transfer'
          ? (await controller.transferProcess(
              sessionId,
              current.process.ownerThreadId,
              current.process.processId,
              issued.commandId,
            ),
            true)
          : kind === 'consume'
            ? (await controller.consumeProcess(
                sessionId,
                current.process.ownerThreadId,
                current.process.processId,
                issued.commandId,
              ),
              true)
            : await controller.terminateProcess(
                sessionId,
                current.process.ownerThreadId,
                current.process.processId,
                issued.commandId,
                {
                  itemId: current.process.itemId,
                  ...(current.process.osPid === undefined ? {} : { osPid: current.process.osPid }),
                },
              );
      if (!accepted) {
        this.executorCommandTransition(sessionId, issued.commandId, 'failed');
        return false;
      }
    } catch (error) {
      // The command remains issued: the same idempotency key is the only retry.
      this.containOperationFailure(sessionId, error);
      return false;
    }
    const latest = this.processActionCurrent(sessionId, issued);
    if (!latest) {
      this.executorCommandTransition(sessionId, issued.commandId, 'superseded');
      return false;
    }
    this.persist({
      ...latest.state,
      executor: {
        ...latest.executor,
        commands: latest.executor.commands!.map((candidate) =>
          candidate.commandId === issued.commandId
            ? { ...candidate, status: 'accepted' as const, updatedAt: this.deps.now() }
            : candidate,
        ),
        ownedProcesses: latest.executor.ownedProcesses.map((candidate) =>
          executorProcessKey(candidate) !== issued.processAction!.processKey
            ? candidate
            : kind === 'transfer'
              ? {
                  ...candidate,
                  ownership: 'supervisor' as const,
                  state: 'detached-active' as const,
                }
              : kind === 'consume'
                ? { ...candidate, state: 'result-consumed' as const }
                : { ...candidate, state: 'terminated-for-budget' as const },
        ),
      },
      updatedAt: this.deps.now(),
    });
    return true;
  }

  private executorCommandTransition(
    sessionId: string,
    commandId: string,
    status: ExecutorCommand['status'],
  ): ExecutorCommand | undefined {
    const state = this.deps.store.find(sessionId);
    const executor = state?.executor;
    const command = executor?.commands?.find((candidate) => candidate.commandId === commandId);
    if (!state || !executor || !command || command.status === status) return command;
    const next = { ...command, status, updatedAt: this.deps.now() };
    this.persist({
      ...state,
      executor: {
        ...executor,
        commands: executor.commands!.map((candidate) =>
          candidate.commandId === commandId ? next : candidate,
        ),
      },
      updatedAt: this.deps.now(),
    });
    return next;
  }

  private scheduleExecutorCommand(
    sessionId: string,
    command: ExecutorCommand,
  ): ExecutorCommand | undefined {
    const state = this.deps.store.find(sessionId);
    const executor = state?.executor;
    if (!state || !executor) return undefined;
    const existing = executor.commands?.find(
      (candidate) => candidate.commandId === command.commandId,
    );
    if (existing) return existing;
    const commands = [...(executor.commands ?? []), command].slice(-32);
    this.persist({
      ...state,
      executor: { ...executor, commands },
      updatedAt: this.deps.now(),
    });
    return command;
  }

  private persistExecutor(sessionId: string, executor: ExecutorLifecycle): boolean {
    const current = this.deps.store.find(sessionId);
    if (!current || JSON.stringify(current.executor) === JSON.stringify(executor)) return false;
    this.persist({ ...current, executor, updatedAt: this.deps.now() });
    return true;
  }

  /** Retain stale commands as evidence; they can never regain writer authority. */
  private supersedeExecutorCommands(
    sessionId: string,
    planIdentity: string,
    plan: SupervisedPlan,
    current?: ExecutorLifecycle,
  ): boolean {
    const state = this.deps.store.find(sessionId);
    const executor = state?.executor;
    if (!state || !executor?.commands?.length) return false;
    const planFingerprint = fingerprint(plan);
    let changed = false;
    const commands = executor.commands.map((command) => {
      const ownershipMismatch =
        Boolean(current) &&
        (command.canonicalPosition !== current!.canonicalPosition ||
          command.canonicalTaskName !== current!.canonicalTaskName ||
          command.taskPath !== current!.taskPath ||
          command.threadId !== current!.threadId);
      const stale =
        command.planIdentity !== planIdentity ||
        command.planFingerprint !== planFingerprint ||
        ownershipMismatch;
      if (!stale || !['scheduled', 'issued'].includes(command.status)) return command;
      changed = true;
      return { ...command, status: 'superseded' as const, updatedAt: this.deps.now() };
    });
    if (!changed) return false;
    this.persist({
      ...state,
      executor: { ...executor, commands },
      updatedAt: this.deps.now(),
    });
    this.audit(sessionId, 'autopilot.executor-command-superseded', {
      count: commands.filter((command) => command.status === 'superseded').length,
    });
    return true;
  }

  private wakeForExecutorChange(sessionId: string, executor: ExecutorLifecycle): boolean {
    const processes = executor.ownedProcesses;
    const conditions: ObservableWakeCondition[] = [
      ...(processes.some((process) => process.state === 'exited-awaiting-result')
        ? (['processExited', 'processResultAvailable'] as const)
        : []),
      ...(processes.some((process) => process.state === 'terminated-for-budget')
        ? (['processLimitBreached'] as const)
        : []),
      'executorChanged',
    ];
    return conditions.some((condition) => this.semanticEvent(sessionId, condition));
  }

  private freshExecutorIdentity(sessionId: string) {
    const replacement = this.deps.store.find(sessionId)?.executor?.replacement;
    if (replacement && this.validReplacement(sessionId, replacement)) return replacement;
    const plan = this.deps.plan(sessionId)?.plan;
    if (!plan) return undefined;
    const stepIndex = plan.steps.findIndex(
      (step) => step.id === plan.currentStepId || step.state === 'WIP',
    );
    const index =
      stepIndex >= 0 ? stepIndex : plan.steps.findIndex((step) => step.state !== 'DONE');
    if (index < 0) return undefined;
    const canonicalTaskName = `l${index + 1}`;
    const generations =
      this.deps
        .activity(sessionId)
        ?.subagents.filter((child) => child.canonicalTaskName === canonicalTaskName)
        .map((child) => child.continuationGeneration ?? 1) ?? [];
    return executorIdentity(canonicalTaskName, Math.max(0, ...generations) + 1);
  }

  private validReplacement(
    sessionId: string,
    replacement: NonNullable<ExecutorLifecycle['replacement']>,
  ): boolean {
    const retained = this.deps.plan(sessionId);
    if (
      !retained ||
      retained.identity !== replacement.planIdentity ||
      fingerprint(retained.plan) !== replacement.planFingerprint
    )
      return false;
    const index = retained.plan.steps.findIndex(
      (step) => step.id === retained.plan.currentStepId || step.state === 'WIP',
    );
    return index >= 0 && replacement.canonicalPosition === `L${index + 1}`;
  }

  /** Converts an exhausted physical executor into one durable root-owned handoff. */
  private scheduleExecutorReplacement(sessionId: string, executor: ExecutorLifecycle): void {
    const current = this.deps.store.find(sessionId);
    const retained = this.deps.plan(sessionId);
    if (!current?.requestedEnabled || !retained || current.executor?.replacement) return;
    const identity = executorIdentity(
      executor.canonicalTaskName,
      executor.continuationGeneration + 1,
    );
    const now = this.deps.now();
    const controlId = this.deps.nextControlId(sessionId, current.generation);
    const replacement: ExecutorLifecycle = {
      ...executor,
      outcome: 'failed',
      replacement: {
        ...identity,
        planIdentity: retained.identity,
        planFingerprint: fingerprint(retained.plan),
      },
      commands: executor.commands?.map((command) =>
        ['scheduled', 'issued'].includes(command.status)
          ? { ...command, status: 'superseded' as const, updatedAt: now }
          : command,
      ),
    };
    this.arm(sessionId, current.generation, now);
    this.persist(
      {
        ...current,
        state: 'backoff',
        executor: replacement,
        nextEvaluationAt: now,
        lastControlId: controlId,
        updatedAt: now,
      },
      {
        sessionId,
        controlId,
        status: 'scheduled',
        createdAt: now,
        updatedAt: now,
        failureCode: null,
      },
      [
        {
          sessionId,
          type: 'autopilot.executor-replacement-scheduled',
          payload: {
            canonicalPosition: identity.canonicalPosition,
            taskName: identity.taskName,
            generation: identity.generation,
          },
          occurredAt: now,
        },
      ],
    );
  }

  private armExecutorRefresh(sessionId: string, delayMs: number): void {
    if (this.executorTimers.has(sessionId)) return;
    const state = this.deps.store.find(sessionId);
    const plan = this.deps.plan(sessionId);
    const executor =
      state && plan
        ? this.currentExecutor(sessionId, plan.plan, state.consecutiveNoProgress, state.executor)
        : undefined;
    const fence =
      state && plan && !this.deps.session(sessionId)?.activeTurnId
        ? {
            generation: state.generation,
            identity: plan.identity,
            fingerprint: fingerprint(plan.plan),
            state: state.state,
            supervision: state.supervision?.outcome ?? null,
            checkpoint: JSON.stringify(state.checkpoints ?? null),
            canonicalPosition: executor?.canonicalPosition ?? null,
            executorThreadId: executor?.threadId ?? null,
            executorGeneration: executor?.continuationGeneration ?? null,
          }
        : null;
    if (!fence) return;
    let delivered = false;
    this.executorTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.executorTimers.delete(sessionId);
        if (delivered) {
          this.audit(sessionId, 'autopilot.executor-refresh-stale', { fence });
          return;
        }
        delivered = true;
        this.enqueue(sessionId, async () => {
          const current = this.deps.store.find(sessionId);
          const currentPlan = this.deps.plan(sessionId);
          const currentChild = fence.executorThreadId
            ? this.deps
                .activity(sessionId)
                ?.subagents.find((child) => (child.threadId ?? child.id) === fence.executorThreadId)
            : null;
          if (
            !current?.requestedEnabled ||
            this.deps.pendingInteraction(sessionId) ||
            current.generation !== fence.generation ||
            current.state !== fence.state ||
            (current.supervision?.outcome ?? null) !== fence.supervision ||
            JSON.stringify(current.checkpoints ?? null) !== fence.checkpoint ||
            currentPlan?.identity !== fence.identity ||
            !currentPlan ||
            fingerprint(currentPlan.plan) !== fence.fingerprint ||
            Boolean(this.deps.session(sessionId)?.activeTurnId) ||
            (fence.executorThreadId !== null &&
              (currentChild?.canonicalPosition !== fence.canonicalPosition ||
                (currentChild.continuationGeneration ?? 1) !== fence.executorGeneration))
          ) {
            this.audit(sessionId, 'autopilot.executor-refresh-stale', { fence });
            return;
          }
          await this.deps.executorController?.refresh(sessionId);
          if (!(await this.enforceSupervisedLifecycle(sessionId, 'processObserved')))
            this.evaluate(sessionId);
        });
      }, delayMs),
    );
  }

  /**
   * A store read can fail after the timer that exposed it has already fired.
   * This retry deliberately needs no lifecycle read to arm; once the store is
   * available again, normal evaluation re-establishes a fully fenced timer.
   */
  private armStoreRecovery(sessionId: string): void {
    if (this.executorTimers.has(sessionId)) return;
    let delivered = false;
    const cancel = this.deps.schedule(() => {
      this.executorTimers.delete(sessionId);
      if (delivered) return;
      delivered = true;
      this.enqueue(sessionId, async () => {
        const current = this.deps.store.find(sessionId);
        if (!current?.requestedEnabled) return;
        this.evaluate(sessionId);
      });
    }, this.deps.policy.executorContinuationMaxMs);
    this.executorTimers.set(sessionId, cancel);
  }

  private armExecutorContinuation(
    sessionId: string,
    delayMs: number,
    threadId: string,
    generation: number,
    trigger: Parameters<NonNullable<AutopilotDependencies['executorController']>['resume']>[3],
  ): void {
    if (this.executorTimers.has(sessionId)) return;
    const state = this.deps.store.find(sessionId);
    const retained = this.deps.plan(sessionId);
    const armedChild = this.deps
      .activity(sessionId)
      ?.subagents.find((child) => (child.threadId ?? child.id) === threadId);
    const fence =
      state && retained
        ? {
            sessionGeneration: state.generation,
            planIdentity: retained.identity,
            planFingerprint: fingerprint(retained.plan),
            canonicalPosition:
              armedChild?.canonicalPosition ?? state.executor?.canonicalPosition ?? null,
            executorThreadId: threadId,
            executorGeneration: generation - 1,
            supervisionOutcome: state.supervision?.outcome ?? null,
            checkpoint: JSON.stringify(state.checkpoints ?? null),
            boundaryState: state.state,
          }
        : null;
    if (!fence || this.deps.session(sessionId)?.activeTurnId) return;
    const commandExecutor = state?.executor;
    if (!commandExecutor) return;
    const requested = this.executorCommand(fence, commandExecutor, generation, trigger);
    const command = this.scheduleExecutorCommand(sessionId, requested);
    // A command that crossed the durable issue boundary is deliberately not
    // replayed: app-server acceptance may have happened before a crash.
    if (!command || command.status !== 'scheduled') return;
    let delivered = false;
    this.executorTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.executorTimers.delete(sessionId);
        if (delivered) {
          this.audit(sessionId, 'autopilot.executor-continuation-stale', {
            threadId,
            generation,
            trigger: trigger.kind,
            fence,
          });
          return;
        }
        delivered = true;
        this.enqueue(sessionId, async () => {
          const current = this.deps.store.find(sessionId);
          const latestPlan = this.deps.plan(sessionId);
          const currentChild = this.deps
            .activity(sessionId)
            ?.subagents.find((child) => (child.threadId ?? child.id) === fence.executorThreadId);
          const valid =
            current?.requestedEnabled &&
            !this.deps.pendingInteraction(sessionId) &&
            current.generation === fence.sessionGeneration &&
            current.state === fence.boundaryState &&
            (current.supervision?.outcome ?? null) === fence.supervisionOutcome &&
            JSON.stringify(current.checkpoints ?? null) === fence.checkpoint &&
            !this.deps.session(sessionId)?.activeTurnId &&
            latestPlan?.identity === fence.planIdentity &&
            latestPlan &&
            fingerprint(latestPlan.plan) === fence.planFingerprint &&
            currentChild?.canonicalPosition === fence.canonicalPosition &&
            (currentChild.continuationGeneration ?? 1) === fence.executorGeneration;
          if (!valid) {
            const ownershipChanged =
              latestPlan?.identity !== fence.planIdentity ||
              !latestPlan ||
              fingerprint(latestPlan.plan) !== fence.planFingerprint ||
              currentChild?.canonicalPosition !== fence.canonicalPosition ||
              (currentChild.continuationGeneration ?? 1) !== fence.executorGeneration;
            this.executorCommandTransition(
              sessionId,
              command.commandId,
              ownershipChanged ? 'superseded' : 'cancelled',
            );
            this.audit(sessionId, 'autopilot.executor-continuation-stale', {
              threadId,
              generation,
              trigger: trigger.kind,
              fence,
            });
            return;
          }
          const issued = this.executorCommandTransition(sessionId, command.commandId, 'issued');
          if (issued?.status !== 'issued') return;
          try {
            await this.deps.executorController?.resume(sessionId, threadId, generation, trigger);
            this.executorCommandTransition(sessionId, command.commandId, 'accepted');
            this.audit(sessionId, 'autopilot.executor-resumed', {
              threadId,
              generation,
              trigger: trigger.kind,
            });
            const latest = this.deps.store.find(sessionId);
            if (latest?.requestedEnabled)
              this.persist({
                ...latest,
                state: 'monitoring',
                consecutiveNoProgress: latest.consecutiveNoProgress + 1,
                ...(latest.executor
                  ? {
                      executor: {
                        ...latest.executor,
                        outcome: 'partial',
                        continuationGeneration: generation,
                        continuationCount: latest.executor.continuationCount + 1,
                        lastActivityAt: this.deps.now(),
                      },
                    }
                  : {}),
                nextEvaluationAt: null,
                updatedAt: this.deps.now(),
              });
          } catch (error) {
            // Only an explicit app-server rejection is safe to retry. A lost
            // response may conceal accepted work, so retain its issued fence.
            if (!explicitExecutorRejection(error)) {
              this.containOperationFailure(sessionId, error);
              this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
              return;
            }
            this.executorCommandTransition(sessionId, command.commandId, 'failed');
            const latest = this.deps.store.find(sessionId);
            const failedExecutor = latest?.executor;
            if (!latest?.requestedEnabled || !failedExecutor) return;
            const resumeFailures = (failedExecutor.resumeFailures ?? 0) + 1;
            const next = {
              ...latest,
              executor: { ...failedExecutor, resumeFailures },
              updatedAt: this.deps.now(),
            };
            this.persist(next);
            if (resumeFailures >= this.deps.policy.retryLimit)
              this.scheduleExecutorReplacement(sessionId, next.executor);
            else this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
          }
        });
      }, delayMs),
    );
  }
  private audit(sessionId: string, type: string, payload: unknown): void {
    const occurredAt = this.deps.now();
    this.commit({ events: [{ sessionId, type, payload, occurredAt }] });
    this.flushOutbox(sessionId);
  }
  private cancelScheduledControl(
    state: AutopilotSession,
    updatedAt: string,
  ): AutopilotControl | undefined {
    if (!state.lastControlId) return undefined;
    const control = this.deps.store.findControl(state.sessionId, state.lastControlId);
    return control?.status === 'scheduled'
      ? { ...control, status: 'cancelled', updatedAt }
      : undefined;
  }
  private updateControl(
    sessionId: string,
    controlId: string,
    status: AutopilotControl['status'],
    failureCode: AutopilotControl['failureCode'],
    turnId: string | null = null,
    eventType?: 'autopilot.turn-started' | 'autopilot.turn-failed',
  ): void {
    const control = this.deps.store.findControl(sessionId, controlId);
    if (!control) return;
    const updated = {
      ...control,
      status,
      failureCode,
      turnId,
      updatedAt: this.deps.now(),
    };
    const occurredAt = this.deps.now();
    this.commit({
      control: updated,
      events: eventType
        ? [
            {
              sessionId,
              type: eventType,
              payload:
                eventType === 'autopilot.turn-failed'
                  ? { controlId, code: failureCode }
                  : { controlId },
              occurredAt,
            },
          ]
        : [],
    });
    this.flushOutbox(sessionId);
  }
  private authoritativeExecutorActive(
    next: AutopilotSession,
    plan: SupervisedPlan | null,
    activity: AgentActivitySnapshot | null,
  ): boolean {
    if (!plan || activity?.confidence !== 'fresh') return false;
    const selected = plan.steps.findIndex(
      (step) => step.id === plan.currentStepId || step.state === 'WIP',
    );
    const index = selected >= 0 ? selected : plan.steps.findIndex((step) => step.state !== 'DONE');
    if (index < 0) return false;
    const position = `L${index + 1}`;
    const taskName = `l${index + 1}`;
    const child = activity.subagents
      .filter(
        (candidate) =>
          candidate.canonicalPosition === position &&
          candidate.canonicalTaskName === taskName &&
          (!next.executor ||
            ((candidate.threadId ?? candidate.id) === next.executor.threadId &&
              candidate.taskPath === next.executor.taskPath)),
      )
      .sort(
        (left, right) => (right.continuationGeneration ?? 1) - (left.continuationGeneration ?? 1),
      )[0];
    return Boolean(
      child &&
      (child.state === 'working' ||
        child.state === 'awaitingAgent' ||
        child.ownedProcesses?.some(
          (process) => process.state === 'running' || process.state === 'detached-active',
        )),
    );
  }
  /** Builds both GET and pre-commit event payloads from the same prospective facts. */
  private snapshotFor(
    next: AutopilotSession,
    prospectiveControl?: AutopilotControl,
  ): AutopilotSnapshot {
    const session = this.deps.session(next.sessionId);
    const plan = this.deps.plan(next.sessionId);
    const activity = this.deps.activity(next.sessionId);
    const now = this.deps.now();
    const control =
      prospectiveControl ??
      (next.lastControlId ? this.deps.store.findControl(next.sessionId, next.lastControlId) : null);
    return autopilotSnapshot(next, this.deps.policy.retryLimit, {
      activeTurn: Boolean(session?.activeTurnId),
      executorActive: this.authoritativeExecutorActive(next, plan?.plan ?? null, activity),
      control: control?.status ?? 'none',
      timerArmed: this.timers.has(next.sessionId),
      reconciling: this.reconciling.has(next.sessionId),
      planMatches: Boolean(plan && plan.identity === next.planIdentity),
      parkedSubscriptionActive:
        Boolean(next.supervision?.waitLease) &&
        this.parkedSubscriptions.get(next.sessionId) === next.supervision?.waitLease?.id,
      transitionFresh: Date.parse(now) - Date.parse(next.updatedAt) <= 120_000,
      observedAt: now,
    });
  }
  private semanticSnapshot(next: AutopilotSession, control?: AutopilotControl): string {
    return JSON.stringify({
      ...this.snapshotFor(next, control),
      updatedAt: '',
    });
  }
  private snapshotEvents(
    next: AutopilotSession,
    control?: AutopilotControl,
  ): readonly AutopilotAuditEvent[] {
    const semantic = this.semanticSnapshot(next, control);
    if (this.publishedSnapshots.get(next.sessionId) === semantic) return [];
    const session = this.deps.session(next.sessionId);
    const plan = this.deps.plan(next.sessionId)?.plan ?? null;
    const activity = this.deps.activity(next.sessionId);
    const snapshot = this.snapshotFor(next, control);
    return [
      {
        sessionId: next.sessionId,
        type: 'autopilot.updated',
        payload: snapshot,
        occurredAt: next.updatedAt,
      },
      ...(session
        ? [
            {
              sessionId: next.sessionId,
              type: 'session.status.updated',
              payload: deriveSessionStatus({
                session,
                plan,
                activity,
                autopilot: snapshot,
                pendingAttention: this.deps.pendingInteraction(next.sessionId),
                observedAt: next.updatedAt,
              }),
              occurredAt: next.updatedAt,
            } satisfies AutopilotAuditEvent,
          ]
        : []),
    ];
  }
  private flushOutbox(sessionId: string): void {
    for (const event of this.deps.store.drainOutbox?.(sessionId) ?? []) {
      this.deps.publish(event.sessionId, event.type, event.payload, event.occurredAt, event.id);
      this.deps.store.acknowledgeOutbox?.(event.id);
    }
  }
  private commit(
    input: Readonly<{
      state?: AutopilotSession;
      control?: AutopilotControl;
      events: readonly AutopilotAuditEvent[];
    }>,
  ): void {
    if (this.deps.store.commit) {
      this.deps.store.commit(input);
      return;
    }
    // Narrow in-memory test-double adapter. Real composition always supplies
    // the transactional implementation above; this path cannot be reached by SQLite.
    if (input.state) this.deps.store.save(input.state);
    if (input.control) this.deps.store.saveControl?.(input.control);
    for (const event of input.events)
      this.deps.publish(event.sessionId, event.type, event.payload, event.occurredAt);
  }
  private legacyClaim(
    sessionId: string,
    controlId: string,
    state: AutopilotSession,
    events: readonly AutopilotAuditEvent[],
  ): AutopilotControl | null {
    const control = this.deps.store.findControl(sessionId, controlId);
    if (!control || control.status !== 'scheduled') return null;
    this.commit({
      state,
      control: { ...control, status: 'issued', updatedAt: state.updatedAt },
      events,
    });
    return { ...control, status: 'issued', updatedAt: state.updatedAt };
  }
  private lastTurnOutcome(
    sessionId: string,
    controlId: string | null,
  ): 'completed' | 'failed' | 'unknown' | undefined {
    if (!controlId) return undefined;
    const control = this.deps.store.findControl(sessionId, controlId);
    if (control?.status === 'failed') return 'failed';
    if (control?.status === 'started') return 'completed';
    return 'unknown';
  }
  private decision(sessionId: string, state: AutopilotSession) {
    if (state.supervision?.outcome === 'parked') return { kind: 'observe' as const };
    const plan = this.deps.plan(sessionId);
    const now = this.deps.now();
    const currentProgressKey = this.progressKey(sessionId);
    return decideAutopilot({
      state,
      plan: plan?.plan ?? null,
      activity: this.deps.activity(sessionId),
      hasPendingInteraction: this.deps.pendingInteraction(sessionId),
      hasActiveAttention: validStructuredBlock(this.deps.attention?.(sessionId) ?? state.blocking),
      lastTurnOutcome: this.lastTurnOutcome(sessionId, state.lastControlId),
      automaticActionCount:
        this.deps.store.automaticActionsSince?.(
          sessionId,
          new Date(Date.parse(now) - this.deps.policy.actionWindowMs).toISOString(),
        ) ?? 0,
      semanticProgressKey: currentProgressKey,
      now,
      policy: this.deps.policy,
    });
  }
  private progressKey(sessionId: string): string {
    const retained = this.deps.plan(sessionId);
    const state = this.deps.store.find(sessionId);
    return this.progressKeyFor(sessionId, state, retained);
  }
  private progressKeyFor(
    sessionId: string,
    state: AutopilotSession | null,
    retained: Readonly<{ plan: SupervisedPlan; identity: string }> | null,
  ): string {
    const activity = this.deps.activity(sessionId);
    const interactions = this.deps.pendingInteraction(sessionId)
      ? [{ id: 'pending', kind: 'session', state: 'pending' }]
      : [];
    return semanticProgressKey({
      plan: {
        identity: retained?.identity ?? 'none',
        fingerprint: retained ? fingerprint(retained.plan) : 'none',
        currentPosition: retained?.plan.currentStepId ?? null,
      },
      review: { status: null },
      checkpoint: {
        pendingTurnId: state?.checkpoints?.pendingTurnId ?? null,
        terminalReviewAccepted: state?.checkpoints?.terminalReviewAccepted ?? false,
      },
      pendingInteractions: interactions,
      executor: {
        generation: state?.executor?.continuationGeneration ?? 0,
        state: state?.executor?.outcome ?? null,
      },
      ownedProcesses: (state?.executor?.ownedProcesses ?? []).map((process) => ({
        id: process.processId,
        state: process.state,
        ownerGeneration: state?.executor?.continuationGeneration ?? 0,
      })),
      childActivity: (activity?.subagents ?? []).map((child) => ({
        id: child.id,
        threadId: child.threadId ?? null,
        taskName: child.canonicalTaskName ?? null,
        position: child.canonicalPosition ?? null,
        generation: child.continuationGeneration ?? 0,
        state: child.state,
        outcome: child.outcome ?? null,
        ownedProcesses: (child.ownedProcesses ?? []).map((process) => ({
          id: process.processId,
          state: process.state,
          ownership: process.ownership,
        })),
      })),
      agentActivity: [
        ...(activity
          ? [
              {
                agentId: 'root',
                // Activity time is liveness-only; semantic progress uses the
                // sequenced state projection, never the observation clock.
                sequence: 0,
                state: activity.root.state,
              },
            ]
          : []),
      ],
    });
  }
  private async reconcile(sessionId: string, generation: number): Promise<void> {
    try {
      const result = await this.deps.reconcile(sessionId);
      const current = this.deps.store.find(sessionId);
      if (!result.compatible || !current || current.generation !== generation)
        throw new Error('INCOMPATIBLE');
      // A compatible reconciliation normally refreshes the activity projection.
      // Do not feed a still-stale projection straight back into reconciliation:
      // that would create an unbounded microtask loop with no timer or event to
      // yield to. A later activity/watchdog event will evaluate it again.
      const activity = this.deps.activity(sessionId);
      if (
        activity?.confidence === 'fresh' &&
        Date.parse(this.deps.now()) - Date.parse(activity.root.lastActivityAt) <=
          this.deps.policy.staleAfterMs
      ) {
        this.evaluate(sessionId);
      } else {
        // A compatible read that did not yield fresh actor evidence is not a
        // healthy wait. Keep one bounded watchdog armed for missed activity or
        // late runtime recovery rather than silently settling the supervisor.
        this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
      }
    } catch {
      const current = this.deps.store.find(sessionId);
      if (!current || current.generation !== generation) return;
      this.persist({
        ...current,
        state: 'monitoring',
        generation: current.generation + 1,
        nextEvaluationAt: null,
        stopReason: 'reconcileFailed',
        updatedAt: this.deps.now(),
      });
      this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
    }
  }
  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(sessionId);
    // Every asynchronous boundary settles locally. In particular, do not
    // discard the promise returned by finally(): that would turn a rejected
    // controller, store, or publisher call into an unhandled rejection and
    // poison the next serial operation.
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        this.containOperationFailure(sessionId, error);
      }
    };
    const next = previous ? previous.then(run, run) : run();
    this.operations.set(sessionId, next);
    void next.then(
      () => {
        if (this.operations.get(sessionId) === next) this.operations.delete(sessionId);
      },
      () => {
        // run() contains failures, but retain a rejection observer as a final
        // guard if a future containment change itself becomes asynchronous.
        if (this.operations.get(sessionId) === next) this.operations.delete(sessionId);
      },
    );
    return next;
  }

  /**
   * Converts an unexpected queued-operation failure into one opaque durable
   * recovery outcome. The recovery path deliberately avoids publish(): an
   * outbox publication failure must not recursively manufacture another
   * rejected promise before a later journal flush can replay the event.
   */
  private containOperationFailure(sessionId: string, error: unknown): void {
    const code = operationFailureCode(error);
    try {
      this.deps.diagnostic?.(sessionId, `operationFailed:${code}`);
    } catch {
      // Diagnostics are advisory and cannot compromise queue liveness.
    }
    let current: AutopilotSession | null = null;
    try {
      current = this.deps.store.find(sessionId);
    } catch {
      try {
        this.armStoreRecovery(sessionId);
      } catch {
        try {
          this.deps.diagnostic?.(sessionId, `operationRecoveryUnavailable:${code}`);
        } catch {
          // A later external lifecycle input may retry after both dependencies recover.
        }
      }
      return;
    }
    if (!current?.requestedEnabled) return;
    const now = this.deps.now();
    const recovery: AutopilotSession = {
      ...current,
      state: 'monitoring',
      generation: current.generation + 1,
      nextEvaluationAt: null,
      stopReason: 'reconcileFailed',
      updatedAt: now,
    };
    try {
      this.commit({
        state: recovery,
        events: [
          {
            sessionId,
            type: 'autopilot.operation-failed',
            payload: { code },
            occurredAt: now,
          },
        ],
      });
    } catch {
      // A failing persistence adapter has no durable surface available in this
      // process. Its observable diagnostic is deliberately independent of
      // that adapter; retain one bounded runtime recovery rather than treating
      // a failed write as if the operation had safely settled.
      try {
        this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
      } catch {
        try {
          this.deps.diagnostic?.(sessionId, `operationRecoveryUnavailable:${code}`);
        } catch {
          // The queue itself remains settled for a future external event.
        }
      }
      return;
    }
    try {
      this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
    } catch {
      // Scheduling is the last recovery capability. If it is unavailable,
      // leave a safe terminal state rather than claim enabled supervision with
      // no reachable continuation.
      try {
        this.commit({
          state: {
            ...recovery,
            state: 'safetyPaused',
            requestedEnabled: false,
            stopReason: 'safetyPaused',
            updatedAt: this.deps.now(),
          },
          events: [
            {
              sessionId,
              type: 'autopilot.operation-recovery-unavailable',
              payload: { code },
              occurredAt: this.deps.now(),
            },
          ],
        });
      } catch {
        // There is no additional in-process action that can safely restore a
        // failed store and scheduler; importantly the serial queue remains
        // settled for a future external recovery event.
      }
    }
  }
}

function explicitExecutorRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['AUTOPILOT_EXECUTOR_UNAVAILABLE', 'AUTOPILOT_EXECUTOR_REJECTED'].includes(error.message)
  );
}

function startFailureCode(error: unknown): AutopilotControl['failureCode'] {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  return /(?:UNAVAILABLE|PERMISSION|DEPENDENCY|CODEX_SESSION_NOT_RUNNING|WRITER_)/.test(code)
    ? 'START_UNAVAILABLE'
    : 'START_FAILED';
}

/** Keep failure telemetry bounded and free of prompts, paths, and error prose. */
function operationFailureCode(error: unknown): 'PERSISTENCE' | 'PUBLICATION' | 'OPERATION' {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  if (/PERSIST|SQLITE|DATABASE|STORE/i.test(code)) return 'PERSISTENCE';
  if (/PUBLISH|OUTBOX|JOURNAL/i.test(code)) return 'PUBLICATION';
  return 'OPERATION';
}

function fingerprint(plan: SupervisedPlan): string {
  return JSON.stringify(
    plan.steps.map((step) => [
      step.id,
      step.state,
      step.reviewStatus,
      step.children.map((child) => [child.id, child.state]),
    ]),
  );
}

function boundedUnique(values: readonly string[], limit: number): readonly string[] {
  return [...new Set(values)].slice(-limit);
}

function boundEpochs(
  epochs: readonly Readonly<{
    target: string;
    epoch: number;
    reopened: boolean;
    completed: boolean;
  }>[],
  currentTarget: string,
): readonly Readonly<{ target: string; epoch: number; reopened: boolean; completed: boolean }>[] {
  const current = epochs.find((entry) => entry.target === currentTarget);
  const retained = epochs
    .filter((entry) => entry.target !== currentTarget)
    .sort((left, right) => left.target.localeCompare(right.target));
  return [...retained.slice(0, current ? 639 : 640), ...(current ? [current] : [])].sort(
    (left, right) => left.target.localeCompare(right.target),
  );
}

function refreshPersistedProcesses(
  persisted: readonly OwnedExecutorProcess[],
  observed: readonly OwnedExecutorProcess[],
  now: string,
): readonly OwnedExecutorProcess[] {
  if (!observed.length) return persisted;
  const priorById = new Map(persisted.map((process) => [executorProcessKey(process), process]));
  return observed.map((process) => {
    const prior = priorById.get(executorProcessKey(process));
    if (!prior) return process;
    const observedAt = prior.observedAt;
    return {
      ...process,
      observedAt,
      elapsedMs: Math.max(process.elapsedMs, Date.parse(now) - Date.parse(observedAt)),
      ownership: prior.ownership === 'supervisor' ? 'supervisor' : process.ownership,
      state:
        prior.state === 'result-consumed' || prior.state === 'terminated-for-budget'
          ? prior.state
          : prior.ownership === 'supervisor' && process.state === 'running'
            ? 'detached-active'
            : process.state,
    };
  });
}

/** A numeric OS PID or process id alone can be reused by a later child operation. */
function executorProcessKey(process: OwnedExecutorProcess): string {
  return JSON.stringify([
    process.ownerThreadId,
    process.ownerTaskPath,
    process.processId,
    process.itemId,
    process.osPid ?? null,
  ]);
}
