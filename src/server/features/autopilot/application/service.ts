/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import {
  autopilotSnapshot,
  disabledAutopilot,
  type AutopilotSession,
  type AutopilotSnapshot,
} from '../domain/autopilot-session.js';
import { decideAutopilot, executionComplete, type AutopilotPolicy } from './policy.js';
import type {
  AutopilotAuditEvent,
  AutopilotControl,
  AutopilotStore,
  AutopilotTurnStarter,
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
  schedule(callback: () => void, delayMs: number): () => void;
  nextControlId(sessionId: string, generation: number): string;
  turnStarter: AutopilotTurnStarter;
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
        state: 'attentionRequired',
        requestedEnabled: false,
        generation: state.generation + 1,
        nextEvaluationAt: null,
        stopReason: 'reconcileFailed',
        updatedAt: this.deps.now(),
      });
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
      prior.planFingerprint === nextFingerprint &&
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
      updatedAt: now,
    };
    this.persist(next);
    this.evaluate(sessionId);
    return this.snapshot(sessionId);
  }
  disable(sessionId: string): AutopilotSnapshot {
    const now = this.deps.now();
    const prior = this.deps.store.find(sessionId) ?? disabledAutopilot(sessionId, now);
    if (!prior.requestedEnabled && prior.state === 'disabled') return this.snapshot(sessionId);
    const next: AutopilotSession = {
      ...prior,
      state: 'disabled',
      requestedEnabled: false,
      generation: prior.generation + 1,
      nextEvaluationAt: null,
      stopReason: 'manualDisabled',
      updatedAt: now,
    };
    this.persist(next);
    this.cancelTimer(sessionId);
    return this.snapshot(sessionId);
  }
  cancel(sessionId: string, reason: 'planRemoved' | 'planReplaced' | 'sessionEnded'): void {
    const prior = this.deps.store.find(sessionId);
    if (!prior) return;
    this.persist({
      ...prior,
      state: 'disabled',
      requestedEnabled: false,
      generation: prior.generation + 1,
      nextEvaluationAt: null,
      stopReason: reason,
      updatedAt: this.deps.now(),
    });
    this.cancelTimer(sessionId);
  }
  evaluate(sessionId: string): AutopilotSnapshot {
    const prior = this.deps.store.find(sessionId);
    if (!prior) return this.snapshot(sessionId);
    const plan = this.deps.plan(sessionId);
    const session = this.deps.session(sessionId);
    const decision = decideAutopilot({
      state: prior,
      plan: plan?.plan ?? null,
      planIdentity: plan?.identity,
      planFingerprint: plan ? fingerprint(plan.plan) : null,
      activity: this.deps.activity(sessionId),
      hasPendingInteraction: this.deps.pendingInteraction(sessionId),
      hasActiveAttention: prior.state === 'attentionRequired',
      lastTurnOutcome: this.lastTurnOutcome(sessionId, prior.lastControlId),
      now: this.deps.now(),
      policy: this.deps.policy,
    });
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
      case 'requestAttention':
        next = {
          ...prior,
          state: 'attentionRequired',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: decision.reason,
          updatedAt: now,
        };
        break;
      case 'complete':
        next = {
          ...prior,
          state: 'completed',
          requestedEnabled: false,
          generation: prior.generation + 1,
          nextEvaluationAt: null,
          stopReason: 'planComplete',
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
    if (next !== prior) this.persist(next);
    return this.snapshot(sessionId);
  }
  planUpdated(sessionId: string): void {
    const prior = this.deps.store.find(sessionId);
    const plan = this.deps.plan(sessionId);
    if (!prior || !plan) return;
    if (prior.planIdentity && prior.planIdentity !== plan.identity) {
      this.cancel(sessionId, 'planReplaced');
      return;
    }
    const nextFingerprint = fingerprint(plan.plan);
    if (prior.planFingerprint !== nextFingerprint) {
      const now = this.deps.now();
      this.persist(
        {
          ...prior,
          planIdentity: plan.identity,
          planFingerprint: nextFingerprint,
          consecutiveNoProgress: 0,
          updatedAt: now,
        },
        undefined,
        [
          {
            sessionId,
            type: 'autopilot.progress-reset',
            payload: { reason: 'planUpdated' },
            occurredAt: now,
          },
        ],
      );
    }
    this.evaluate(sessionId);
  }
  turnCompleted(sessionId: string): void {
    this.completionTimers.get(sessionId)?.();
    this.completionTimers.set(
      sessionId,
      this.deps.schedule(() => {
        this.completionTimers.delete(sessionId);
        this.evaluate(sessionId);
      }, this.deps.policy.quiescenceMs),
    );
  }
  manualSend(sessionId: string): void {
    this.cancelTimer(sessionId);
    const prior = this.deps.store.find(sessionId);
    if (!prior || !prior.requestedEnabled) return;
    this.persist({
      ...prior,
      state: 'monitoring',
      generation: prior.generation + 1,
      nextEvaluationAt: null,
      lastControlId: null,
      updatedAt: this.deps.now(),
    });
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
    const session = this.deps.session(sessionId);
    if (
      !current ||
      current.generation !== generation ||
      !current.requestedEnabled ||
      session?.activeTurnId ||
      this.deps.pendingInteraction(sessionId)
    )
      return;
    const id = current.lastControlId;
    if (!id) return;
    if (!this.recordControlIssued(sessionId, id)) return;
    try {
      await this.deps.turnStarter.start(sessionId, id, generation);
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
      // Availability, permission, and dependency failures cannot be repaired
      // by another identical synthetic turn.  They remain a durable, explicit
      // human stop; unknown transport failures still consume the retry budget.
      if (failureCode === 'START_UNAVAILABLE') {
        const latest = this.deps.store.find(sessionId);
        if (latest?.requestedEnabled)
          this.persist({
            ...latest,
            state: 'attentionRequired',
            requestedEnabled: false,
            generation: latest.generation + 1,
            nextEvaluationAt: null,
            stopReason: 'attentionRequired',
            updatedAt: this.deps.now(),
          });
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
      if (this.deps.activity(sessionId)?.confidence === 'fresh') this.evaluate(sessionId);
    } catch {
      const current = this.deps.store.find(sessionId);
      if (!current || current.generation !== generation) return;
      this.persist({
        ...current,
        state: 'attentionRequired',
        requestedEnabled: false,
        generation: current.generation + 1,
        nextEvaluationAt: null,
        stopReason: 'reconcileFailed',
        updatedAt: this.deps.now(),
      });
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
