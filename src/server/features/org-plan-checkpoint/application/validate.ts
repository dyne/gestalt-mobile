/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { OrgPlanCheckpoint } from '../../../../shared/contracts/org-plan-checkpoint.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { checkpointTarget } from '../../autopilot/domain/supervised-lifecycle.js';

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
  completedTargets: readonly string[] = [],
  pendingTarget?: string,
): OrgPlanCheckpoint | null {
  if (kind === 'terminalReviewAccepted')
    return {
      version: 1,
      kind,
      planIdentity,
      verdict: 'ACCEPT',
    };
  const pending = pendingTarget ? (JSON.parse(pendingTarget) as string[]) : undefined;
  const reviewedId =
    (pending?.[0] === 'l1' ? pending[1] : undefined) ??
    publicationReason?.match(/^review:([^:]{1,128}):REVIEWED$/)?.[1];
  const completedId =
    (pending?.[0] === 'l2' ? pending[2] : undefined) ??
    publicationReason?.match(/^l2:([^:]{1,128}):DONE$/)?.[1];
  // Publication identifies the actual transition, regardless of list order.
  // Without it, expand only an unambiguous boundary; never guess the last row.
  const allReviewed = plan.steps.filter(
    (step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED',
  );
  const unreportedReviewed = allReviewed.filter(
    (step) => !completedTargets.includes(checkpointTarget('l1', step.id)),
  );
  const reviewed = reviewedId || !unreportedReviewed.length ? allReviewed : unreportedReviewed;
  const allCompleted = plan.steps.flatMap((parent) =>
    parent.reviewStatus === 'UNREVIEWED'
      ? parent.children
          .filter(
            (child) =>
              child.state === 'DONE' &&
              (!completedId || child.id === completedId) &&
              (pending?.[0] !== 'l2' || parent.id === pending[1]),
          )
          .map((child) => ({ parent, child }))
      : [],
  );
  const unreportedCompleted = allCompleted.filter(
    ({ parent, child }) => !completedTargets.includes(checkpointTarget('l2', parent.id, child.id)),
  );
  const completed = completedId || !unreportedCompleted.length ? allCompleted : unreportedCompleted;
  const selected =
    kind === 'l1Accepted'
      ? reviewedId
        ? reviewed.find((step) => step.id === reviewedId)
        : reviewed.length === 1
          ? reviewed[0]
          : undefined
      : completed.length === 1
        ? completed[0]?.parent
        : undefined;
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
  const child = completed[0]?.child;
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
  if (checkpoint.kind === 'terminalReviewAccepted') {
    if (
      !plan.steps.length ||
      !plan.steps.every((step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED')
    )
      return { valid: false, reasonCode: 'terminalReviewIncomplete' };
    for (const [index, step] of plan.steps.entries()) {
      const result = validateCompletedChildren(step, input.hasActiveL1Writer(`L${index + 1}`));
      if (!result.valid) return result;
    }
    return { valid: true };
  }
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
  return validateCompletedChildren(l1, input.hasActiveL1Writer(position));
}

function validateCompletedChildren(
  l1: SupervisedPlan['steps'][number],
  activeWriter: boolean,
): OrgPlanCheckpointValidation {
  const incompleteChild = l1.children.find((child) => child.state !== 'DONE');
  if (incompleteChild)
    return {
      valid: false,
      reasonCode: 'l1ChildrenIncomplete',
      expected: { childrenDone: true },
      observed: { childrenDone: false, childState: incompleteChild.state },
    };
  if (activeWriter)
    return {
      valid: false,
      reasonCode: 'executorStillActive',
      expected: { executorTerminal: true },
      observed: { executorTerminal: false },
    };
  return { valid: true };
}
