/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';
import type { ExecutorIdentity } from '../domain/supervised-lifecycle.js';

export const AUTOPILOT_PROMPT_VERSION = 'v13';
export const AUTOPILOT_CONTINUATION_PROMPT =
  'Inspect the active supervised Org Plan. Refer to every L1 as L<a> and each nested L2 as L<a>.<b>, using one-based positions. Spawn exactly one executor per L1 and pass the exact literal task_name l<a>: l1 for L1, l2 for L2, and so on. Never create an L2-specific task name or append a title, role, nickname, plan name, or generated label. A validated DONE L2 and an accepted L1 are mandatory answer boundaries. The corresponding gestalt_org_plan_checkpoint call must be the last tool call of that root turn: immediately emit exactly one boundary final and end the turn, without followup_task, review, executor launch, or later milestone work. An accepted L1 always ends the root turn with a chat answer: never continue into the next L1 or emit post-acceptance documentation as commentary. Roll up commentary, files, verification, and commands since the previous boundary into that one answer; all later milestone activity belongs to a new root turn. On this later Autopilot turn, resume the same executor after an L2 boundary or launch exactly one fresh canonical executor for the next L1 after an accepted-L1 boundary. Treat a status question as an interruption: answer briefly, then perform the applicable continuation in the same turn. Before sending any blocker response or yielding because progress cannot continue safely, call gestalt_org_plan_attention for the matching decision-table blocker; never rely on blocker prose as the signal. When explicit human permission is required for a physical executor replacement, include executorReplacement with the exact canonicalTaskName; Mobile alone computes and persists the physical generation. Do not call attention for routine progress or a recoverable failure. Before yielding for known long work, call gestalt_autopilot_wait_lease version 2 with relevant observable wake conditions and a bounded maxWaitMs; it is one episode, so reassess before registering another in a later turn. Yield only when its response contains accepted:true; accepted:false means no continuation was registered and requires same-turn supervision. For GitHub PR CI, start an owned gh pr checks --watch process and lease processExited plus processResultAvailable while it runs. When the Autopilot probe is active, register the compatible wait lease, declare genuine attention, or immediately do actionable work; never acknowledge waiting in prose. Do not send a status-only response.';
export const AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT =
  'Continue the same assigned Org L1 from its durable state. A prior turn ending did not complete the objective. Consume any supplied process result and take the next legal L2 action. Whenever an L2 reaches DONE, return its concise structured evidence and end the executor turn so the root can publish that mandatory answer boundary. Also report at the L1 review boundary or through structured attention.';

/** Builds a physical launch instruction while keeping durable L1 identity canonical. */
export function autopilotExecutorLaunchPrompt(identity: ExecutorIdentity): string {
  const launch = `Launch task_name ${identity.taskName} for canonical ${identity.canonicalPosition} with agent_type org-plan-executor and reasoning_effort high; the profile selects gpt-5.6-terra by default, so do not override its model. Retain the canonical label in status and review output.`;
  if (identity.generation === 1) return `${AUTOPILOT_CONTINUATION_PROMPT} ${launch}`;
  return `${AUTOPILOT_CONTINUATION_PROMPT} ${launch} This exact replacement generation ${identity.generation} is durably authorized by Mobile; do not infer another generation from this prompt or the roster; the durable ${identity.canonicalTaskName} slot may remain reserved. Do not reuse that task_name or attempt to change an existing agent's model in place. Interrupt the previous physical executor if it is still running, then spawn the authorized ${identity.taskName}. Transfer sole ${identity.canonicalPosition} ownership and continue from its durable Org Plan and worktree state.`;
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

/**
 * Classifies actor state against the plan position that can legally run next.
 * Completed canonical executors remain visible evidence, but their terminal
 * topology cannot indefinitely turn a fresh read into a reconciliation loop.
 */
function classifySupervisedActivity(
  activity: AgentActivitySnapshot,
  plan: SupervisedPlan,
): AgentActivityDisposition {
  const selected = plan.steps.findIndex(
    (step) => step.id === plan.currentStepId || step.state === 'WIP',
  );
  const index = selected >= 0 ? selected : plan.steps.findIndex((step) => step.state !== 'DONE');
  if (index < 0) return classifyAgentActivity(activity);
  const position = index + 1;
  const retained = activity.subagents.filter((child) => {
    const match = /^L([1-9]\d*)$/.exec(child.canonicalPosition ?? '');
    if (!match) return true;
    const historical = Number(match[1]) < position;
    const supervisedProcess = child.ownedProcesses?.some(
      (process) =>
        process.ownership === 'supervisor' &&
        (process.state === 'running' || process.state === 'detached-active'),
    );
    return !historical || supervisedProcess;
  });
  // A fresh authoritative roster can retain the current executor while its
  // runtime is unloaded. Re-reading that same status cannot load it: allow the
  // coordinator's fenced continuation to resume the existing physical thread.
  const resumable = (child: AgentActivitySnapshot['subagents'][number]) =>
    child.canonicalPosition === `L${position}` &&
    Boolean(child.taskPath && child.canonicalTaskName) &&
    child.state === 'disconnected';
  // An aggregate-only observation cannot prove which child is historical.
  if (retained.length === activity.subagents.length && !retained.some(resumable))
    return classifyAgentActivity(activity);
  if (
    activity.root.state === 'awaitingHuman' ||
    retained.some((child) => child.state === 'awaitingHuman')
  )
    return 'attention';
  if (
    activity.root.state === 'working' ||
    retained.some(
      (child) =>
        child.state === 'working' ||
        child.state === 'awaitingAgent' ||
        child.ownedProcesses?.some(
          (process) =>
            (child.state !== 'disconnected' || process.ownership === 'supervisor') &&
            (process.state === 'running' || process.state === 'detached-active'),
        ),
    )
  )
    return 'active';
  if (
    activity.root.state === 'disconnected' ||
    retained.some((child) => child.state === 'disconnected' && !resumable(child))
  )
    return 'reconcile';
  const rootSettled =
    activity.root.state === 'idle' ||
    activity.root.state === 'blocked' ||
    activity.root.state === 'awaitingAgent';
  const childrenSettled = retained.every(
    (child) => child.state === 'idle' || child.state === 'blocked' || resumable(child),
  );
  return rootSettled && childrenSettled ? 'settled' : 'observe';
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
  /** Opaque current key used only to keep a throughput cap from overriding real progress. */
  semanticProgressKey?: string;
  now: string;
  policy: AutopilotPolicy;
}): AutopilotDecision {
  const { state, plan, activity, hasPendingInteraction, now, policy } = input;
  // A late checkpoint final must not relabel a terminal safety pause as Off.
  // Only an explicit enable/recovery transition can grant new authority.
  if (state.state === 'safetyPaused') return { kind: 'observe' };
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
  const semanticProgressObserved = Boolean(
    input.semanticProgressKey &&
    state.supervision &&
    input.semanticProgressKey !== state.supervision.progressKey,
  );
  const semanticLoopConfirmed = (state.supervision?.unchangedContinuations ?? 3) >= 3;
  if (
    (input.automaticActionCount ?? 0) > policy.actionLimit &&
    !semanticProgressObserved &&
    semanticLoopConfirmed
  )
    return { kind: 'safetyPause', reason: 'actionRateExceeded' };
  if (!activity || activity.confidence !== 'fresh') return { kind: 'reconcile' };
  if (Date.parse(now) - Date.parse(activity.root.observedAt) > policy.staleAfterMs)
    return { kind: 'reconcile' };
  const disposition = classifySupervisedActivity(activity, plan);
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
