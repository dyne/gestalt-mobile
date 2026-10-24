/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PlanTodoState = 'TODO' | 'WIP' | 'DONE' | 'SUSPENDED';
export type PlanPriority = 'A' | 'B' | 'C';
export type PlanLevel = 1 | 2;
export type PlanReviewStatus = 'UNREVIEWED' | 'REVIEWED';

export type PlanModelId = 'gpt-6-luna' | 'gpt-6-sol' | 'gpt-6.1-sol';
export type PlanModelPolicy = Readonly<{
  version: 1;
  model: PlanModelId;
  reasoningEffort: 'medium' | 'high' | 'xhigh';
  rationale: string;
  allowedFallbacks: readonly PlanModelId[];
  escalationTrigger: string;
  necessity: Readonly<{
    kind: 'unresolved-correctness' | 'specific-reasoning';
    whyMediumInadequate: string;
    evidence: string;
    affectedScope: string;
    returnToMedium: string;
    scopeReassessment?: string;
  }> | null;
}>;

export type PlanStepDescription = Readonly<{
  effort?: string;
  goal?: string;
  notes?: string;
  why?: string;
  change?: string;
  tests?: string;
  doneWhen?: string;
}>;

/** Optional telemetry recorded by the org-plan lifecycle for either plan level. */
export type PlanStepMeasurement = Readonly<{
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  elapsedSeconds?: number;
  weeklyRemainingStart?: number;
  weeklyRemainingCurrent?: number;
  weeklyRemainingEnd?: number;
  weeklyPercentUsed?: number;
  tokensStart?: number;
  tokensCurrent?: number;
  tokensEnd?: number;
  tokensUsed?: number;
}>;

/** An immutable execution step from the strict supervised org-plan dialect. */
export type PlanStep = Readonly<{
  id: string;
  title: string;
  level: PlanLevel;
  state: PlanTodoState;
  priority: PlanPriority;
  reviewStatus?: PlanReviewStatus;
  skills?: readonly string[];
  description: PlanStepDescription;
  measurement?: PlanStepMeasurement;
  modelPolicy?: PlanModelPolicy;
  children: readonly PlanStep[];
}>;

/** Session-scoped read model; it deliberately contains no source file path. */
export type SupervisedPlan = Readonly<{
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  /** Absent for legacy plans. Existing v1 plans default to configured assurance. */
  modelPolicyVersion?: 1;
  modelPolicyAssurance?: 'configured' | 'runtime-attested';
  steps: readonly PlanStep[];
  totalSteps: number;
  doneSteps: number;
  allDone: boolean;
  /** Complete only when every L1 is reviewed and every L2 is done. */
  executionComplete?: boolean;
  currentStepId: string;
}>;

/** A fact emitted when a session's retained supervised plan is replaced. */
export type PlanProgressed = Readonly<{
  type: 'plan.updated';
  plan: SupervisedPlan;
}>;

export type PlanUnavailableReason =
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'MISSING_TITLE'
  | 'INVALID_MODEL_POLICY'
  | 'MALFORMED_ORG'
  | 'DUPLICATE_ID'
  | 'MULTIPLE_WIP'
  | 'MISSING_REQUIRED_FIELD';

export type PlanProjectionResult =
  | Readonly<{ kind: 'available'; plan: SupervisedPlan }>
  | Readonly<{ kind: 'unavailable'; reason: PlanUnavailableReason }>;

/** Suspended work is a barrier: no later implementation may be selected. */
export function currentExecutableL1Index(plan: SupervisedPlan): number {
  const boundary = plan.steps.findIndex((step) => step.state === 'SUSPENDED');
  const eligible = (index: number) => boundary < 0 || index < boundary;
  const selected = plan.steps.findIndex(
    (step, index) =>
      eligible(index) &&
      (step.id === plan.currentStepId ||
        step.children.some((child) => child.id === plan.currentStepId) ||
        step.state === 'WIP'),
  );
  if (selected >= 0) return selected;
  return plan.steps.findIndex((step, index) => eligible(index) && step.state !== 'DONE');
}
