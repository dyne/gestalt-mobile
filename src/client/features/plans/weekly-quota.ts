/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PlanStep, SupervisedPlan } from './contracts.js';

/** Returns the active plan step's latest weekly account-wide percentage remaining. */
export function weeklyQuotaLeft(plan: SupervisedPlan | undefined): number | null {
  if (!plan) return null;
  const remaining = findStep(plan.steps, plan.currentStepId)?.measurement?.weeklyRemainingCurrent;
  return typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    ? Math.round(remaining)
    : null;
}

function findStep(steps: readonly PlanStep[], id: string): PlanStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const found = findStep(step.children, id);
    if (found) return found;
  }
  return undefined;
}
