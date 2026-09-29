/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';

/** Expands a host-owned compact boundary signal from authoritative plan state. */
export function resolveOrgPlanCheckpointSignal(
  kind: OrgPlanCheckpoint['kind'],
  plan: SupervisedPlan,
  planIdentity: string,
): OrgPlanCheckpoint | null {
  if (kind === 'terminalReviewAccepted')
    return {
      version: 1,
      kind,
      planIdentity,
      verdict: 'ACCEPT',
    };
  const selected =
    plan.steps.find((step) => step.id === plan.currentStepId) ??
    [...plan.steps].reverse().find((step) => step.state === 'DONE' || step.state === 'WIP');
  if (!selected) return null;
  const l1Position = `L${plan.steps.indexOf(selected) + 1}`;
  if (kind === 'l1Accepted')
    return {
      version: 1,
      kind,
      planIdentity,
      l1Id: selected.id,
      position: l1Position,
      verdict: 'ACCEPT',
      commit: { kind: 'notRequired' },
    };
  const child = [...selected.children].reverse().find((step) => step.state === 'DONE');
  if (!child) return null;
  return {
    version: 1,
    kind,
    planIdentity,
    l1Id: selected.id,
    l2Id: child.id,
    position: `${l1Position}.${selected.children.indexOf(child) + 1}`,
    status: 'DONE',
    changes: 'Validated from the authoritative Org Plan boundary.',
    files: 'Recorded by the supervised executor.',
    tests: 'Focused verification recorded before the boundary.',
  };
}

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
  if (checkpoint.kind === 'l2Completed') {
    const l2 = l1.children.find((step) => step.id === checkpoint.l2Id);
    if (!l2) return false;
    return (
      checkpoint.position === `${position}.${l1.children.indexOf(l2) + 1}` &&
      l2.state === 'DONE' &&
      l1.reviewStatus === 'UNREVIEWED'
    );
  }
  return (
    checkpoint.position === position &&
    l1.state === 'DONE' &&
    l1.reviewStatus === 'REVIEWED' &&
    !input.hasActiveL1Writer(position)
  );
}
