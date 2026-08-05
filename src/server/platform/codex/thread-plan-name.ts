/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';

/** Derives the bounded, session-private label sent to Codex for a live plan only. */
export function threadPlanName(plan: SupervisedPlan, limit = 120): string {
  const l1 = plan.steps.filter((step) => step.level === 1);
  const active = l1.find((step) => step.state === 'WIP');
  const awaiting = l1.find((step) => step.state === 'DONE' && step.reviewStatus === 'UNREVIEWED');
  const suffix = active
    ? `L1 ${l1.indexOf(active) + 1}/${l1.length}`
    : awaiting
      ? `Review ${l1.indexOf(awaiting) + 1}/${l1.length}`
      : l1.length > 0 && l1.every((step) => step.state === 'DONE' && step.reviewStatus === 'REVIEWED')
        ? 'Complete'
        : 'Authoring';
  return `${truncateTitle(plan.title, Math.max(1, limit - suffix.length - 3))} — ${suffix}`;
}

function truncateTitle(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`;
}
