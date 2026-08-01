/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PlanTodoState = 'TODO' | 'WIP' | 'DONE';
export type PlanPriority = 'A' | 'B' | 'C';
export type PlanLevel = 1 | 2;
export type PlanReviewStatus = 'UNREVIEWED' | 'REVIEWED';

export type PlanStepDescription = Readonly<{
  effort?: string;
  goal?: string;
  notes?: string;
  why?: string;
  change?: string;
  tests?: string;
  doneWhen?: string;
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
  children: readonly PlanStep[];
}>;

/** Session-scoped read model; it deliberately contains no source file path. */
export type SupervisedPlan = Readonly<{
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  steps: readonly PlanStep[];
  totalSteps: number;
  doneSteps: number;
  allDone: boolean;
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
  | 'MALFORMED_ORG'
  | 'DUPLICATE_ID'
  | 'MULTIPLE_WIP'
  | 'MISSING_REQUIRED_FIELD';

export type PlanProjectionResult =
  | Readonly<{ kind: 'available'; plan: SupervisedPlan }>
  | Readonly<{ kind: 'unavailable'; reason: PlanUnavailableReason }>;
