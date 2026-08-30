/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import { createHash } from 'node:crypto';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
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
  type ExecutorLifecycle,
  type OwnedExecutorProcess,
  type StructuredBlock,
  type SupervisedLifecycleEvent,
  validStructuredBlock,
} from '../domain/supervised-lifecycle.js';
import {
  classifyAgentActivity,
  decideAutopilot,
  executionComplete,
  type AutopilotPolicy,
} from './policy.js';
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
  private readonly publishedSnapshots = new Map<string, string>();
  /** Serializes asynchronous watchdog and timer work per relay session. */
  private readonly operations = new Map<string, Promise<void>>();
  constructor(private readonly deps: AutopilotDependencies) {}

  snapshot(sessionId: string): AutopilotSnapshot {
    return autopilotSnapshot(
      this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, this.deps.now()),
      this.deps.policy.retryLimit,
    );
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
      ['disabled', 'attentionRequired', 'completed'].includes(state.state)
    )
      return;
    // A relay restart deliberately drops its writer before rehydrating the
    // coordinator. The plan-status watcher is authoritative and asynchronous,
    // so retaining enabled durable state until it supplies the projection is
    // safer than interpreting this short bootstrap gap as plan removal.
    if (!this.deps.plan(sessionId)) return;
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
      updatedAt: now,
    };
    this.persist(next, cancelled);
    this.cancelTimer(sessionId);
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
        updatedAt: now,
      },
      cancelled,
    );
    this.cancelTimer(sessionId);
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
        this.enqueue(sessionId, () => this.reconcile(sessionId, prior.generation));
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
        this.persist(next, control, [
          {
            sessionId,
            type: 'autopilot.continuation-scheduled',
            payload: { controlId: scheduledControlId },
            occurredAt: now,
          },
        ]);
        next = prior;
        this.arm(sessionId, prior.generation, decision.at);
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
      decision.kind === 'disable'
    )
      this.cancelTimer(sessionId);
    if (next !== prior) {
      const cancelled =
        decision.kind === 'requestAttention' ||
        decision.kind === 'complete' ||
        decision.kind === 'disable'
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
      this.persist(
        {
          ...state,
          checkpoints: { ...state.checkpoints, pendingTurnId: null },
          updatedAt: occurredAt,
        },
        undefined,
        [
          {
            sessionId,
            type: state.checkpoints.terminalReviewAccepted
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
    this.activitySettled(sessionId, 'rootFinalAttempt');
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
    const reported = previous?.reportedL1Ids ?? [];
    const key = createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
    const acceptedKeys = previous?.acceptedKeys ?? [];
    if (acceptedKeys.includes(key)) return true;
    if (checkpoint.kind === 'l1Accepted' && reported.includes(checkpoint.l1Id)) return false;
    if (checkpoint.kind === 'terminalReviewAccepted' && previous?.terminalReviewAccepted)
      return false;
    const checkpoints = {
      protocolVersion: 1 as const,
      planIdentity: retained.identity,
      reportedL1Ids: checkpoint.kind === 'l1Accepted' ? [...reported, checkpoint.l1Id] : reported,
      acceptedKeys: [...acceptedKeys, key],
      pendingTurnId: turnId,
      terminalReviewAccepted:
        checkpoint.kind === 'terminalReviewAccepted' || previous?.terminalReviewAccepted === true,
    };
    this.persist({ ...prior, checkpoints, updatedAt: occurredAt }, undefined, [
      {
        sessionId,
        type:
          checkpoint.kind === 'l1Accepted'
            ? 'org-plan.milestone-checkpointed'
            : 'org-plan.terminal-review-checkpointed',
        payload:
          checkpoint.kind === 'l1Accepted'
            ? { l1Id: checkpoint.l1Id, position: checkpoint.position, turnId }
            : { turnId },
        occurredAt,
      },
    ]);
    return true;
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
      this.cancel(sessionId, 'planReplaced');
      return;
    }
    if (executionComplete(plan.plan)) this.evaluate(sessionId);
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
    if (replacing) this.cancelTimer(sessionId);
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
    if (!activity || activity.confidence !== 'fresh') return;
    const disposition = classifyAgentActivity(activity);
    if (disposition === 'attention') {
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
        const current = this.deps.store.find(sessionId);
        if (!current?.requestedEnabled || current.state !== 'monitoring') return;
        this.enqueue(sessionId, async () => {
          if (!(await this.enforceSupervisedLifecycle(sessionId, event))) this.evaluate(sessionId);
        });
      }, this.deps.policy.quiescenceMs),
    );
  }
  manualSend(sessionId: string): void {
    this.cancelTimer(sessionId);
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
    const events = [
      ...this.snapshotEvents(next),
      { sessionId, type: 'autopilot.control-issued', payload: { controlId }, occurredAt: now },
    ];
    const control = this.deps.store.claimControlIssued
      ? this.deps.store.claimControlIssued(sessionId, controlId, now, next, events)
      : this.legacyClaim(sessionId, controlId, next, events);
    if (!control) return false;
    this.publishedSnapshots.set(sessionId, this.semanticSnapshot(next));
    this.flushOutbox(sessionId);
    return true;
  }
  private persist(
    next: AutopilotSession,
    control?: AutopilotControl,
    events: readonly AutopilotAuditEvent[] = [],
  ): void {
    const snapshotEvents = this.snapshotEvents(next);
    this.commit({
      state: next,
      ...(control ? { control } : {}),
      events: [...snapshotEvents, ...events],
    });
    if (snapshotEvents.length)
      this.publishedSnapshots.set(next.sessionId, this.semanticSnapshot(next));
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
    if (executor) this.persistExecutor(sessionId, executor);
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
        controller.transferProcess(sessionId, decision.action.process.ownerThreadId, processId);
        if (executor)
          this.persistExecutor(sessionId, {
            ...executor,
            ownedProcesses: executor.ownedProcesses.map((process) =>
              process.processId === processId
                ? { ...process, ownership: 'supervisor', state: 'detached-active' }
                : process,
            ),
          });
        this.audit(sessionId, 'autopilot.process-monitoring', {
          threadId: decision.action.process.ownerThreadId,
          processId,
        });
        this.armExecutorRefresh(sessionId, decision.action.pollAfterMs);
        return true;
      }
      case 'consumeProcessResult': {
        const processId = decision.action.processId;
        controller.consumeProcess(sessionId, decision.action.threadId, processId);
        if (executor)
          this.persistExecutor(sessionId, {
            ...executor,
            ownedProcesses: executor.ownedProcesses.map((process) =>
              process.processId === processId ? { ...process, state: 'result-consumed' } : process,
            ),
          });
        this.audit(sessionId, 'autopilot.process-result-consumed', {
          threadId: decision.action.threadId,
          processId,
          resultArtifact: decision.action.resultArtifact,
        });
        if (executor)
          this.armExecutorContinuation(
            sessionId,
            this.deps.policy.executorContinuationBaseMs,
            executor.threadId,
            executor.continuationGeneration + 1,
            {
              kind: 'processExited',
              processId,
              resultArtifact: decision.action.resultArtifact,
            },
          );
        return true;
      }
      case 'terminateProcess': {
        const processId = decision.action.processId;
        const terminated = await controller.terminateProcess(
          sessionId,
          decision.action.threadId,
          processId,
        );
        if (terminated)
          this.audit(sessionId, 'autopilot.process-terminated', {
            threadId: decision.action.threadId,
            processId,
            reason: 'resourceBudget',
          });
        if (terminated && executor)
          this.persistExecutor(sessionId, {
            ...executor,
            ownedProcesses: executor.ownedProcesses.map((process) =>
              process.processId === processId
                ? { ...process, state: 'terminated-for-budget' }
                : process,
            ),
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
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
      )[0];
    if (
      !child?.taskPath ||
      !child.canonicalTaskName ||
      child.state === 'disconnected' ||
      child.outcome === 'cancelled' ||
      child.outcome === 'failed'
    ) {
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
    };
  }

  private persistExecutor(sessionId: string, executor: ExecutorLifecycle): void {
    const current = this.deps.store.find(sessionId);
    if (!current || JSON.stringify(current.executor) === JSON.stringify(executor)) return;
    this.persist({ ...current, executor, updatedAt: this.deps.now() });
  }

  private freshExecutorIdentity(sessionId: string) {
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

  private armExecutorRefresh(sessionId: string, delayMs: number): void {
    if (this.executorTimers.has(sessionId)) return;
    this.executorTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.executorTimers.delete(sessionId);
        this.enqueue(sessionId, async () => {
          await this.deps.executorController?.refresh(sessionId);
          if (!(await this.enforceSupervisedLifecycle(sessionId, 'processObserved')))
            this.evaluate(sessionId);
        });
      }, delayMs),
    );
  }

  private armExecutorContinuation(
    sessionId: string,
    delayMs: number,
    threadId: string,
    generation: number,
    trigger: Parameters<NonNullable<AutopilotDependencies['executorController']>['resume']>[3],
  ): void {
    if (this.executorTimers.has(sessionId)) return;
    this.executorTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.executorTimers.delete(sessionId);
        this.enqueue(sessionId, async () => {
          const current = this.deps.store.find(sessionId);
          if (!current?.requestedEnabled || this.deps.pendingInteraction(sessionId)) return;
          try {
            await this.deps.executorController?.resume(sessionId, threadId, generation, trigger);
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
          } catch {
            this.armExecutorRefresh(sessionId, this.deps.policy.executorContinuationMaxMs);
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
  private semanticSnapshot(next: AutopilotSession): string {
    return JSON.stringify({
      ...autopilotSnapshot(next, this.deps.policy.retryLimit),
      updatedAt: '',
    });
  }
  private snapshotEvents(next: AutopilotSession): readonly AutopilotAuditEvent[] {
    const semantic = this.semanticSnapshot(next);
    if (this.publishedSnapshots.get(next.sessionId) === semantic) return [];
    return [
      {
        sessionId: next.sessionId,
        type: 'autopilot.updated',
        payload: autopilotSnapshot(next, this.deps.policy.retryLimit),
        occurredAt: next.updatedAt,
      },
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
    const plan = this.deps.plan(sessionId);
    const now = this.deps.now();
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
      now,
      policy: this.deps.policy,
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
      )
        this.evaluate(sessionId);
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
    // Start the first operation synchronously through its pre-await safety
    // checks; later operations serialize behind it for this session.
    const next = previous ? previous.catch(() => undefined).then(operation) : operation();
    this.operations.set(sessionId, next);
    void next.finally(() => {
      if (this.operations.get(sessionId) === next) this.operations.delete(sessionId);
    });
    return next;
  }
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

function refreshPersistedProcesses(
  persisted: readonly OwnedExecutorProcess[],
  observed: readonly OwnedExecutorProcess[],
  now: string,
): readonly OwnedExecutorProcess[] {
  if (!observed.length) return persisted;
  const priorById = new Map(persisted.map((process) => [process.processId, process]));
  return observed.map((process) => {
    const prior = priorById.get(process.processId);
    if (!prior) return process;
    const observedAt = prior.observedAt;
    return {
      ...process,
      observedAt,
      elapsedMs: Math.max(process.elapsedMs, Date.parse(now) - Date.parse(observedAt)),
      ownership: prior.ownership === 'supervisor' ? 'supervisor' : process.ownership,
      state:
        prior.ownership === 'supervisor' && process.state === 'running'
          ? 'detached-active'
          : process.state,
    };
  });
}
