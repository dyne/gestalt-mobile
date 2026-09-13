/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExecutorLifecycle, StructuredBlock } from './supervised-lifecycle.js';
import {
  observableWakeConditions,
  type ObservableWakeCondition,
  type SupervisionProtocolState,
} from './supervision-protocol.js';

export type AutopilotState =
  'disabled' | 'monitoring' | 'backoff' | 'attentionRequired' | 'completed' | 'safetyPaused';

export type AutopilotStopReason =
  | 'manualDisabled'
  | 'planRequired'
  | 'planComplete'
  | 'sessionUnavailable'
  | 'attentionRequired'
  | 'noPlanProgress'
  | 'reconcileFailed'
  | 'startUnavailable'
  | 'actionRateExceeded'
  | 'planRemoved'
  | 'planReplaced'
  | 'sessionEnded'
  | 'safetyPaused';

/** Durable, session-owned control state. It intentionally excludes plan paths and prompt text. */
export type AutopilotSession = Readonly<{
  sessionId: string;
  state: AutopilotState;
  requestedEnabled: boolean;
  planIdentity: string | null;
  planFingerprint: string | null;
  generation: number;
  consecutiveNoProgress: number;
  nextEvaluationAt: string | null;
  lastControlId: string | null;
  stopReason: AutopilotStopReason | null;
  executor?: ExecutorLifecycle;
  blocking?: StructuredBlock;
  supervision?: SupervisionProtocolState;
  checkpoints?: Readonly<{
    protocolVersion: 1;
    planIdentity: string;
    reportedL1Ids: readonly string[];
    acceptedKeys: readonly string[];
    pendingTurnId: string | null;
    terminalReviewAccepted: boolean;
  }>;
  updatedAt: string;
}>;

export type AutopilotSnapshot = Readonly<{
  state: AutopilotState;
  enabled: boolean;
  /** Requested intent and healthy continuation are intentionally distinct. */
  health: Readonly<{
    healthy: boolean;
    phase:
      | 'off'
      | 'rootWorking'
      | 'continuationScheduled'
      | 'waitingForAgentEvent'
      | 'checkingState'
      | 'needsYou'
      | 'safetyPaused'
      | 'complete'
      | 'degraded';
    supervision:
      | 'active'
      | 'probeRequired'
      | 'parked'
      | 'retrying'
      | 'attentionRequired'
      | 'safetyPaused'
      | 'none';
    wait: Readonly<{ present: boolean; wakeCategories: readonly ObservableWakeCondition[] }>;
    observedAt: string;
    lastTransitionAt: string;
    nextExpectedAction: string;
    degradationReason?:
      | 'missingContinuation'
      | 'invalidWaitLease'
      | 'controllerUnavailable'
      | 'staleTransition'
      | 'planMismatch';
  }>;
  reason?: AutopilotStopReason;
  retry: Readonly<{ position: number; limit: number }>;
  /** Opaque server control provenance; never prompt or conversation content. */
  lastAutomaticAction?: Readonly<{ controlId: string; summary: string }>;
  nextEvaluationAt?: string;
  updatedAt: string;
  executor?: ExecutorLifecycle;
  blocking?: StructuredBlock;
}>;

export function disabledAutopilot(sessionId: string, now: string): AutopilotSession {
  return {
    sessionId,
    state: 'disabled',
    requestedEnabled: false,
    planIdentity: null,
    planFingerprint: null,
    generation: 0,
    consecutiveNoProgress: 0,
    nextEvaluationAt: null,
    lastControlId: null,
    stopReason: 'manualDisabled',
    updatedAt: now,
  };
}

export type ControllerHealthFacts = Readonly<{
  activeTurn: boolean;
  /** Fresh direct-child/process evidence, never a historical roster row. */
  executorActive: boolean;
  control: 'scheduled' | 'issued' | 'started' | 'failed' | 'cancelled' | 'none';
  timerArmed: boolean;
  reconciling: boolean;
  planMatches: boolean;
  /** A parked lease is healthy only while this coordinator owns its live subscription. */
  parkedSubscriptionActive: boolean;
  transitionFresh: boolean;
  observedAt: string;
}>;

export function autopilotSnapshot(
  state: AutopilotSession,
  retryLimit: number,
  facts: ControllerHealthFacts = {
    activeTurn: false,
    executorActive: false,
    control: 'none',
    timerArmed: false,
    reconciling: false,
    planMatches: false,
    parkedSubscriptionActive: false,
    transitionFresh: false,
    observedAt: state.updatedAt,
  },
): AutopilotSnapshot {
  const supervision = state.supervision?.outcome ?? 'none';
  const waitCategories = supportedWakeCategories(
    state.supervision?.waitLease?.wakeConditions ?? [],
  );
  const parkedWait =
    supervision === 'parked' && waitCategories.length > 0 && facts.parkedSubscriptionActive;
  const evaluationAt = state.nextEvaluationAt ? Date.parse(state.nextEvaluationAt) : Number.NaN;
  const scheduled =
    state.state === 'backoff' &&
    facts.control === 'scheduled' &&
    facts.timerArmed &&
    Number.isFinite(evaluationAt) &&
    evaluationAt > Date.parse(facts.observedAt);
  const rootWorking = facts.activeTurn;
  // Runtime observations are current at observedAt.  A slow or old durable
  // transition must not turn an actually active root/timer/reconciliation or
  // installed wait lease into a false idle signal.
  const liveContinuation =
    parkedWait || scheduled || rootWorking || facts.executorActive || facts.reconciling;
  const healthy =
    state.requestedEnabled &&
    facts.planMatches &&
    !['attentionRequired', 'safetyPaused'].includes(supervision) &&
    !['attentionRequired', 'safetyPaused', 'completed', 'disabled'].includes(state.state) &&
    liveContinuation;
  const phase =
    state.state === 'disabled'
      ? 'off'
      : state.state === 'completed'
        ? 'complete'
        : state.state === 'attentionRequired'
          ? 'needsYou'
          : state.state === 'safetyPaused' || supervision === 'safetyPaused'
            ? 'safetyPaused'
            : healthy && (parkedWait || facts.executorActive)
              ? 'waitingForAgentEvent'
              : healthy && scheduled
                ? 'continuationScheduled'
                : healthy && (supervision === 'probeRequired' || facts.reconciling)
                  ? 'checkingState'
                  : healthy && rootWorking
                    ? 'rootWorking'
                    : 'degraded';
  const nextExpectedAction =
    phase === 'rootWorking'
      ? 'Wait for the root turn to settle.'
      : phase === 'continuationScheduled'
        ? 'Run the scheduled continuation.'
        : phase === 'waitingForAgentEvent'
          ? parkedWait
            ? 'Wait for a subscribed agent or process event.'
            : 'Wait for the active executor or owned process to settle.'
          : phase === 'checkingState'
            ? 'Reconcile supervised execution state.'
            : phase === 'needsYou'
              ? 'Respond to the pending attention request.'
              : phase === 'complete'
                ? 'No further plan action is required.'
                : phase === 'off'
                  ? 'Enable Autopilot to supervise an incomplete plan.'
                  : phase === 'safetyPaused'
                    ? 'Resume manually after reviewing the safety pause.'
                    : 'Restore a valid continuation before relying on Autopilot.';
  return {
    state: state.state,
    enabled: state.requestedEnabled,
    health: {
      healthy,
      phase,
      supervision,
      wait: {
        present: Boolean(state.supervision?.waitLease),
        wakeCategories: [...waitCategories].slice(0, 9),
      },
      observedAt: facts.observedAt,
      lastTransitionAt: state.updatedAt,
      nextExpectedAction,
      ...(!healthy && state.requestedEnabled
        ? {
            degradationReason: !facts.planMatches
              ? ('planMismatch' as const)
              : !facts.transitionFresh ||
                  (Number.isFinite(evaluationAt) && evaluationAt <= Date.parse(facts.observedAt))
                ? ('staleTransition' as const)
                : state.supervision?.waitLease && !parkedWait
                  ? ('invalidWaitLease' as const)
                  : ('missingContinuation' as const),
          }
        : {}),
    },
    ...(state.stopReason ? { reason: state.stopReason } : {}),
    retry: { position: state.consecutiveNoProgress, limit: retryLimit },
    ...(state.lastControlId
      ? {
          lastAutomaticAction: {
            controlId: state.lastControlId,
            summary:
              state.state === 'backoff'
                ? 'Automatic continuation scheduled.'
                : 'Automatic continuation issued.',
          },
        }
      : {}),
    ...(state.nextEvaluationAt ? { nextEvaluationAt: state.nextEvaluationAt } : {}),
    ...(state.executor ? { executor: state.executor } : {}),
    ...(state.blocking ? { blocking: state.blocking } : {}),
    updatedAt: state.updatedAt,
  };
}

function supportedWakeCategories(
  conditions: readonly unknown[],
): readonly ObservableWakeCondition[] {
  if (conditions.length > observableWakeConditions.length) return [];
  const categories = conditions.filter(
    (condition): condition is ObservableWakeCondition =>
      typeof condition === 'string' &&
      (observableWakeConditions as readonly string[]).includes(condition),
  );
  return categories.length === conditions.length && new Set(categories).size === categories.length
    ? categories
    : [];
}
