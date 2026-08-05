/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from './supervised-plan.js';

/** A path-free summary of one validated, workspace-local Org plan. */
export type WorkspacePlanEntry = Readonly<{
  planName: string;
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  totalSteps: number;
  doneSteps: number;
  allDone: boolean;
}>;

export type WorkspacePlanReadResult =
  | Readonly<{ kind: 'available'; plan: SupervisedPlan }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;
