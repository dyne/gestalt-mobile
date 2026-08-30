/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { orgPlanPosition } from '../../../shared/org-plan-position.js';
import type { PlanStep, SupervisedPlan } from './contracts.js';

export type PlanPresentation = Readonly<{
  phase: 'implementing' | 'awaiting review' | 'milestone reported' | 'terminal review' | 'complete';
  label: string;
  current?: Readonly<{ id: string; position: string; title: string; state: PlanStep['state'] }>;
  reviewedL1s: number;
  totalL1s: number;
}>;

export function presentPlan(plan: SupervisedPlan): PlanPresentation {
  const reviewedL1s = plan.steps.filter((step) => step.reviewStatus === 'REVIEWED').length;
  const totalL1s = plan.steps.length;
  const current = currentStep(plan);
  const awaiting = plan.steps.find(
    (step) => step.state === 'DONE' && step.reviewStatus === 'UNREVIEWED',
  );
  if (awaiting) {
    const position = orgPlanPosition(plan.steps.indexOf(awaiting) + 1);
    return {
      phase: 'awaiting review',
      label: `Awaiting ${position} review`,
      current,
      reviewedL1s,
      totalL1s,
    };
  }
  if (totalL1s > 0 && reviewedL1s === totalL1s)
    return { phase: 'terminal review', label: 'Terminal review', current, reviewedL1s, totalL1s };
  if (reviewedL1s > 0 && !current)
    return {
      phase: 'milestone reported',
      label: 'Preparing milestone summary',
      current,
      reviewedL1s,
      totalL1s,
    };
  if (current)
    return {
      phase: 'implementing',
      label: `Implementing ${current.position} ${current.title}`,
      current,
      reviewedL1s,
      totalL1s,
    };
  return {
    phase: plan.allDone ? 'terminal review' : 'implementing',
    label: plan.allDone ? 'Terminal review' : 'Implementing',
    current,
    reviewedL1s,
    totalL1s,
  };
}

function currentStep(plan: SupervisedPlan): PlanPresentation['current'] {
  for (const [l1Index, l1] of plan.steps.entries()) {
    if (l1.id === plan.currentStepId)
      return {
        id: l1.id,
        position: orgPlanPosition(l1Index + 1),
        title: l1.title,
        state: l1.state,
      };
    const l2Index = l1.children.findIndex((child) => child.id === plan.currentStepId);
    if (l2Index >= 0) {
      const child = l1.children[l2Index]!;
      return {
        id: child.id,
        position: orgPlanPosition(l1Index + 1, l2Index + 1),
        title: child.title,
        state: child.state,
      };
    }
  }
  return undefined;
}
