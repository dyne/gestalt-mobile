/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PlanTodoState = 'TODO' | 'WIP' | 'DONE';
export type PlanPriority = 'A' | 'B' | 'C';
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

export type PlanStep = Readonly<{
  id: string;
  title: string;
  level: 1 | 2;
  state: PlanTodoState;
  priority: PlanPriority;
  reviewStatus?: PlanReviewStatus;
  skills?: readonly string[];
  description: PlanStepDescription;
  children: readonly PlanStep[];
}>;

/** The complete retained plan projection supplied by the relay. */
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

export type RelayPlanEvent = Readonly<{
  sequence: number;
  type: string;
  payload: unknown;
}>;

export function isSupervisedPlan(value: unknown): value is SupervisedPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<SupervisedPlan>;
  return (
    typeof plan.title === 'string' &&
    Array.isArray(plan.steps) &&
    typeof plan.totalSteps === 'number' &&
    typeof plan.doneSteps === 'number' &&
    typeof plan.allDone === 'boolean' &&
    typeof plan.currentStepId === 'string'
  );
}
