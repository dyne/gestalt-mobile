/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';

export function validOrgPlanCheckpoint(
  input: Readonly<{
    checkpoint: OrgPlanCheckpoint;
    plan: SupervisedPlan;
    planIdentity: string;
    rootOwned: boolean;
    hasActiveL1Writer(position: string): boolean;
  }>,
): boolean {
  const { checkpoint, plan, planIdentity, rootOwned } = input;
  if (!rootOwned || checkpoint.planIdentity !== planIdentity) return false;
  if (checkpoint.kind === 'terminalReviewAccepted')
    return plan.steps.every((step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED');
  const l1 = plan.steps.find((step) => step.id === checkpoint.l1Id);
  if (!l1) return false;
  const position = `L${plan.steps.indexOf(l1) + 1}`;
  return (
    checkpoint.position === position &&
    l1.state === 'DONE' &&
    l1.reviewStatus === 'REVIEWED' &&
    !input.hasActiveL1Writer(position)
  );
}
