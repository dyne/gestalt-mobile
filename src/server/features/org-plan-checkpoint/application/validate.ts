/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';

export type OrgPlanCheckpointFailureReason =
  | 'rootNotOwner'
  | 'planIdentityMismatch'
  | 'terminalReviewIncomplete'
  | 'l1NotFound'
  | 'l2NotFound'
  | 'checkpointPositionMismatch'
  | 'l2NotDone'
  | 'l1AlreadyReviewed'
  | 'l1NotDone'
  | 'l1NotReviewed'
  | 'l1ChildrenIncomplete'
  | 'executorStillActive';

export type OrgPlanCheckpointValidation =
  | Readonly<{ valid: true }>
  | Readonly<{
      valid: false;
      reasonCode: OrgPlanCheckpointFailureReason;
      expected?: Readonly<Record<string, string | boolean | null>>;
      observed?: Readonly<Record<string, string | boolean | null>>;
    }>;

/** Terminal roster entries remain visible and are not active implementation writers. */
export function hasActiveL1Writer(
  snapshot: Readonly<{
    subagents: readonly {
      canonicalPosition?: string;
      state: string;
      outcome?: 'partial' | 'cancelled' | 'failed';
    }[];
  }>,
  position: string,
): boolean {
  return snapshot.subagents.some(
    (child) =>
      child.canonicalPosition === position &&
      ['working', 'awaitingAgent', 'awaitingHuman'].includes(child.state),
  );
}

/** Expands a host-owned compact boundary signal from authoritative plan state. */
export function resolveOrgPlanCheckpointSignal(
  kind: OrgPlanCheckpoint['kind'],
  plan: SupervisedPlan,
  planIdentity: string,
  publicationReason: string | null = null,
): OrgPlanCheckpoint | null {
  if (kind === 'terminalReviewAccepted')
    return {
      version: 1,
      kind,
      planIdentity,
      verdict: 'ACCEPT',
    };
  const reviewedId = publicationReason?.match(/^review:([^:]{1,128}):REVIEWED$/)?.[1];
  const selected =
    kind === 'l1Accepted'
      ? ((reviewedId
          ? plan.steps.find(
              (step) =>
                step.id === reviewedId && step.state === 'DONE' && step.reviewStatus === 'REVIEWED',
            )
          : undefined) ??
        [...plan.steps]
          .reverse()
          .find((step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED'))
      : (plan.steps.find((step) => step.id === plan.currentStepId) ??
        [...plan.steps].reverse().find((step) => step.state === 'DONE' || step.state === 'WIP'));
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
  return validateOrgPlanCheckpoint(input).valid;
}

export function validateOrgPlanCheckpoint(
  input: Readonly<{
    checkpoint: OrgPlanCheckpoint;
    plan: SupervisedPlan;
    planIdentity: string;
    rootOwned: boolean;
    hasActiveL1Writer(position: string): boolean;
  }>,
): OrgPlanCheckpointValidation {
  const { checkpoint, plan, planIdentity, rootOwned } = input;
  if (!rootOwned) return { valid: false, reasonCode: 'rootNotOwner' };
  if (checkpoint.planIdentity !== planIdentity)
    return { valid: false, reasonCode: 'planIdentityMismatch' };
  if (checkpoint.kind === 'terminalReviewAccepted')
    return plan.steps.every((step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED')
      ? { valid: true }
      : { valid: false, reasonCode: 'terminalReviewIncomplete' };
  const l1 = plan.steps.find((step) => step.id === checkpoint.l1Id);
  if (!l1) return { valid: false, reasonCode: 'l1NotFound' };
  const position = `L${plan.steps.indexOf(l1) + 1}`;
  if (checkpoint.kind === 'l2Completed') {
    const l2 = l1.children.find((step) => step.id === checkpoint.l2Id);
    if (!l2) return { valid: false, reasonCode: 'l2NotFound' };
    const expectedPosition = `${position}.${l1.children.indexOf(l2) + 1}`;
    if (checkpoint.position !== expectedPosition)
      return {
        valid: false,
        reasonCode: 'checkpointPositionMismatch',
        expected: { position: expectedPosition },
        observed: { position: checkpoint.position },
      };
    if (l2.state !== 'DONE')
      return {
        valid: false,
        reasonCode: 'l2NotDone',
        expected: { l2State: 'DONE' },
        observed: { l2State: l2.state },
      };
    return l1.reviewStatus === 'UNREVIEWED'
      ? { valid: true }
      : { valid: false, reasonCode: 'l1AlreadyReviewed' };
  }
  if (checkpoint.position !== position)
    return {
      valid: false,
      reasonCode: 'checkpointPositionMismatch',
      expected: { position },
      observed: { position: checkpoint.position },
    };
  if (l1.state !== 'DONE')
    return {
      valid: false,
      reasonCode: 'l1NotDone',
      expected: { l1State: 'DONE' },
      observed: { l1State: l1.state },
    };
  if (l1.reviewStatus !== 'REVIEWED')
    return {
      valid: false,
      reasonCode: 'l1NotReviewed',
      expected: { reviewStatus: 'REVIEWED' },
      observed: { reviewStatus: l1.reviewStatus ?? null },
    };
  const incompleteChild = l1.children.find((child) => child.state !== 'DONE');
  if (incompleteChild)
    return {
      valid: false,
      reasonCode: 'l1ChildrenIncomplete',
      expected: { childrenDone: true },
      observed: { childrenDone: false, childState: incompleteChild.state },
    };
  if (input.hasActiveL1Writer(position))
    return {
      valid: false,
      reasonCode: 'executorStillActive',
      expected: { executorTerminal: true },
      observed: { executorTerminal: false },
    };
  return { valid: true };
}
