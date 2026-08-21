/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from './supervised-plan.js';

/** A workspace-relative Org file, with a preview when it uses the supervised-plan dialect. */
export type WorkspacePlanEntry = Readonly<{
  /** Normalized path below the workspace; never an absolute filesystem path. */
  planName: string;
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  previewAvailable: boolean;
  totalSteps?: number;
  doneSteps?: number;
  allDone?: boolean;
}>;

export type WorkspacePlanReadResult =
  | Readonly<{ kind: 'available'; plan: SupervisedPlan }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;
