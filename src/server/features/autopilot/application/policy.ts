/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';

export const AUTOPILOT_PROMPT_VERSION = 'v1';
export const AUTOPILOT_CONTINUATION_PROMPT =
  'Inspect the active supervised Org Plan. Invoke gestalt_org_plan_attention only for a decision-table blocker; otherwise immediately perform the next legal lifecycle action. Do not send a status-only response.';

export type AutopilotPolicy = Readonly<{
  quiescenceMs: number;
  staleAfterMs: number;
  retryLimit: number;
  backoffMs(attempt: number): number;
  promptVersion: typeof AUTOPILOT_PROMPT_VERSION;
}>;

export const defaultAutopilotPolicy: AutopilotPolicy = Object.freeze({
  quiescenceMs: 1_000,
  staleAfterMs: 30_000,
  retryLimit: 3,
  backoffMs: (attempt) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt)),
  promptVersion: AUTOPILOT_PROMPT_VERSION,
});

export type AutopilotDecision =
  | Readonly<{ kind: 'observe' }>
  | Readonly<{ kind: 'reconcile' }>
  | Readonly<{ kind: 'scheduleContinuation'; at: string }>
  | Readonly<{
      kind: 'requestAttention';
      reason: 'attentionRequired' | 'noPlanProgress' | 'reconcileFailed';
    }>
  | Readonly<{ kind: 'complete' }>
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
  now: string;
  policy: AutopilotPolicy;
}): AutopilotDecision {
  const { state, plan, activity, hasPendingInteraction, now, policy } = input;
  if (input.hasActiveAttention || state.state === 'attentionRequired')
    return { kind: 'requestAttention', reason: 'attentionRequired' };
  if (!state.requestedEnabled) return { kind: 'disable', reason: 'manualDisabled' };
  if (!plan) return { kind: 'disable', reason: 'planRequired' };
  if (executionComplete(plan)) return { kind: 'complete' };
  if (hasPendingInteraction) return { kind: 'requestAttention', reason: 'attentionRequired' };
  if (!activity || activity.confidence !== 'fresh') return { kind: 'reconcile' };
  if (Date.parse(now) - Date.parse(activity.root.lastActivityAt) > policy.staleAfterMs)
    return { kind: 'reconcile' };
  const disposition = classifyAgentActivity(activity);
  if (disposition === 'attention') return { kind: 'requestAttention', reason: 'attentionRequired' };
  if (disposition === 'reconcile') return { kind: 'reconcile' };
  if (disposition !== 'settled') return { kind: 'observe' };
  // The outcome is intentionally interpreted only through durable lack of plan
  // progress: a failed or unknown automatic turn may retry within the same
  // bounded budget, while a completed turn with no fingerprint change does too.
  if (
    state.consecutiveNoProgress >= policy.retryLimit &&
    ['completed', 'failed', 'unknown', undefined].includes(input.lastTurnOutcome)
  )
    return { kind: 'requestAttention', reason: 'noPlanProgress' };
  return {
    kind: 'scheduleContinuation',
    at: new Date(Date.parse(now) + policy.backoffMs(state.consecutiveNoProgress)).toISOString(),
  };
}
