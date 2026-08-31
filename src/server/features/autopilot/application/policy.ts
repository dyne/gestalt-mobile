/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';
import type { ExecutorIdentity } from '../domain/supervised-lifecycle.js';

export const AUTOPILOT_PROMPT_VERSION = 'v5';
export const AUTOPILOT_CONTINUATION_PROMPT =
  'Inspect the active supervised Org Plan. Refer to every L1 as L<a> and each nested L2 as L<a>.<b>, using one-based positions. For a subagent dedicated to that position, use the collaboration-safe task_name l<a> or l<a>_<b> and refer to it by its canonical L label. Invoke gestalt_org_plan_attention only for a decision-table blocker. When the Autopilot probe is active, register gestalt_autopilot_wait_lease with an observable wake condition, declare genuine attention, or immediately do actionable work; never acknowledge waiting in prose. Do not send a status-only response.';
export const AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT =
  'Continue the same assigned Org L1 from its durable state. A prior turn ending did not complete the objective. Consume any supplied process result, take the next legal L2 action, and report only at the L1 review boundary or through structured attention.';

/** Builds a physical launch instruction while keeping durable L1 identity canonical. */
export function autopilotExecutorLaunchPrompt(identity: ExecutorIdentity): string {
  const launch = `Launch task_name ${identity.taskName} for canonical ${identity.canonicalPosition}; retain the canonical label in status and review output.`;
  if (identity.generation === 1) return `${AUTOPILOT_CONTINUATION_PROMPT} ${launch}`;
  return `${AUTOPILOT_CONTINUATION_PROMPT} ${launch} This is replacement generation ${identity.generation}: the durable ${identity.canonicalTaskName} slot may remain reserved. Do not reuse that task_name or attempt to change an existing agent's model in place. Interrupt the previous physical executor if it is still running, then spawn ${identity.taskName} with agent_type worker and an explicit model selected by the supervisor. Transfer sole ${identity.canonicalPosition} ownership and continue from its durable Org Plan and worktree state.`;
}

export type AutopilotPolicy = Readonly<{
  quiescenceMs: number;
  staleAfterMs: number;
  retryLimit: number;
  actionLimit: number;
  actionWindowMs: number;
  executorContinuationBaseMs: number;
  executorContinuationMaxMs: number;
  processPollMs: number;
  processMaxElapsedMs: number;
  processMaxRssBytes: number;
  backoffMs(attempt: number): number;
  promptVersion: typeof AUTOPILOT_PROMPT_VERSION;
}>;

export const defaultAutopilotPolicy: AutopilotPolicy = Object.freeze({
  quiescenceMs: 1_000,
  staleAfterMs: 30_000,
  retryLimit: 3,
  actionLimit: 12,
  actionWindowMs: 10 * 60_000,
  executorContinuationBaseMs: 1_000,
  executorContinuationMaxMs: 60_000,
  processPollMs: 1_000,
  processMaxElapsedMs: 2 * 60 * 60_000,
  processMaxRssBytes: 12 * 1024 * 1024 * 1024,
  backoffMs: (attempt) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt)),
  promptVersion: AUTOPILOT_PROMPT_VERSION,
});

export type AutopilotDecision =
  | Readonly<{ kind: 'observe' }>
  | Readonly<{ kind: 'reconcile' }>
  | Readonly<{ kind: 'scheduleContinuation'; at: string }>
  | Readonly<{
      kind: 'requestAttention';
      reason:
        | 'attentionRequired'
        | 'noPlanProgress'
        | 'reconcileFailed'
        | 'startUnavailable'
        | 'actionRateExceeded';
    }>
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'safetyPause'; reason: 'actionRateExceeded' }>
  | Readonly<{
      kind: 'disable';
      reason: 'manualDisabled' | 'planRequired' | 'planComplete' | 'sessionUnavailable';
    }>;

export function executionComplete(plan: SupervisedPlan): boolean {
  return (
    plan.executionComplete ??
    plan.steps.every(
      (step) =>
        step.state === 'DONE' &&
        step.reviewStatus === 'REVIEWED' &&
        step.children.every((child) => child.state === 'DONE'),
    )
  );
}

export type AgentActivityDisposition = 'active' | 'settled' | 'attention' | 'reconcile' | 'observe';

/** Classifies fresh actor topology; the caller owns freshness and durable interaction checks. */
export function classifyAgentActivity(activity: AgentActivitySnapshot): AgentActivityDisposition {
  if (activity.root.state === 'awaitingHuman' || activity.aggregateSubagents === 'awaitingHuman')
    return 'attention';
  if (activity.root.state === 'disconnected' || activity.aggregateSubagents === 'disconnected')
    return 'reconcile';
  if (
    activity.root.state === 'working' ||
    activity.aggregateSubagents === 'working' ||
    activity.aggregateSubagents === 'awaitingAgent'
  )
    return 'active';
  const rootSettled =
    activity.root.state === 'idle' ||
    activity.root.state === 'blocked' ||
    activity.root.state === 'awaitingAgent';
  const subagentsSettled =
    activity.aggregateSubagents === 'idle' || activity.aggregateSubagents === 'blocked';
  return rootSettled && subagentsSettled ? 'settled' : 'observe';
}

/** A deliberately pure, exhaustive safety gate. Adapters may only enact this result. */
export function decideAutopilot(input: {
  state: AutopilotSession;
  plan: SupervisedPlan | null;
  activity: AgentActivitySnapshot | null;
  hasPendingInteraction: boolean;
  hasActiveAttention?: boolean;
  lastTurnOutcome?: 'completed' | 'failed' | 'unknown';
  automaticActionCount?: number;
  now: string;
  policy: AutopilotPolicy;
}): AutopilotDecision {
  const { state, plan, activity, hasPendingInteraction, now, policy } = input;
  if (input.hasActiveAttention)
    return {
      kind: 'requestAttention',
      reason:
        state.stopReason === 'noPlanProgress' ||
        state.stopReason === 'reconcileFailed' ||
        state.stopReason === 'startUnavailable' ||
        state.stopReason === 'actionRateExceeded'
          ? state.stopReason
          : 'attentionRequired',
    };
  if (!state.requestedEnabled) return { kind: 'disable', reason: 'manualDisabled' };
  if (!plan) return { kind: 'disable', reason: 'planRequired' };
  if (executionComplete(plan)) {
    // Checkpoint-aware sessions deliberately reserve a later root turn for
    // terminal whole-branch review.  The Org projection remains authoritative:
    // this only controls whether a completed L1 may end the current report turn.
    if (state.checkpoints?.protocolVersion === 1 && !state.checkpoints.terminalReviewAccepted)
      return {
        kind: 'scheduleContinuation',
        at: new Date(Date.parse(now) + policy.backoffMs(state.consecutiveNoProgress)).toISOString(),
      };
    return { kind: 'complete' };
  }
  // Quiz, approval, and other held requests are ordinary session work. Only a
  // validated Org attention record may turn an incomplete plan into a human stop.
  if (hasPendingInteraction) return { kind: 'observe' };
  if ((input.automaticActionCount ?? 0) > policy.actionLimit)
    return { kind: 'safetyPause', reason: 'actionRateExceeded' };
  if (!activity || activity.confidence !== 'fresh') return { kind: 'reconcile' };
  if (Date.parse(now) - Date.parse(activity.root.lastActivityAt) > policy.staleAfterMs)
    return { kind: 'reconcile' };
  const disposition = classifyAgentActivity(activity);
  if (disposition === 'attention') return { kind: 'observe' };
  if (disposition === 'reconcile') return { kind: 'reconcile' };
  if (disposition !== 'settled') return { kind: 'observe' };
  // Automatic action counts and partial generations pace continuation, but
  // cannot manufacture a human blocker while durable Org state remains WIP.
  return {
    kind: 'scheduleContinuation',
    at: new Date(Date.parse(now) + policy.backoffMs(state.consecutiveNoProgress)).toISOString(),
  };
}
