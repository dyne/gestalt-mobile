/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PlanTodoState = 'TODO' | 'WIP' | 'DONE';
export type PlanPriority = 'A' | 'B' | 'C';
export type PlanReviewStatus = 'UNREVIEWED' | 'REVIEWED';
export type { PlanSignalReason } from '../../../shared/contracts/plan-signal.js';

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

export type PlanStep = Readonly<{
  id: string;
  title: string;
  level: 1 | 2;
  state: PlanTodoState;
  priority: PlanPriority;
  reviewStatus?: PlanReviewStatus;
  skills?: readonly string[];
  description: PlanStepDescription;
  measurement?: PlanStepMeasurement;
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

export type RelayPlanUpdate = Readonly<{ plan: SupervisedPlan; reason: PlanSignalReason | null }>;

export function isRelayPlanUpdate(value: unknown): value is RelayPlanUpdate {
  if (!value || typeof value !== 'object') return false;
  const update = value as Partial<RelayPlanUpdate>;
  return isSupervisedPlan(update.plan) && (update.reason === null || isPlanSignalReason(update.reason));
}

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
import {
  isPlanSignalReason,
  type PlanSignalReason,
} from '../../../shared/contracts/plan-signal.js';
