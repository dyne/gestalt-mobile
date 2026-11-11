/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LastOrgPlan } from '../../sessions/model/relay-session.js';
import type { PlanStatusUpdate } from './ports.js';
import type { PlanStep } from '../domain/supervised-plan.js';

/** Displaying a draft is not an execution claim. Keep established claims across updates. */
export function planAttachmentSupervision(
  previous: LastOrgPlan | undefined,
  update: Extract<PlanStatusUpdate, { kind: 'updated' }>,
  retainedSupervision: boolean,
): boolean {
  const sameAttachment = previous?.attached && previous.path === update.planPath;
  const progressed = (steps: readonly PlanStep[]): boolean =>
    steps.some(
      (step) =>
        step.state !== 'TODO' ||
        step.reviewStatus === 'REVIEWED' ||
        !!step.measurement?.startedAt ||
        progressed(step.children),
    );
  if (
    !!(sameAttachment && previous.supervision === true) ||
    retainedSupervision ||
    update.reason === 'supervision-start' ||
    update.reason === 'work-start' ||
    update.reason === 'checkpoint' ||
    !!update.reason?.match(/^(?:l2:|review:|measure:)/)
  )
    return true;
  if (update.reason === 'authoring-start' || (sameAttachment && previous.supervision === false))
    return false;
  return (
    progressed(update.plan.steps) ||
    // Unknown legacy publications cannot prove that a previous supervisor was only authoring.
    !!(sameAttachment && previous.supervision === undefined && update.reason === null)
  );
}
