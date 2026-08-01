/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../domain/supervised-plan.js';

export type PlanStatusUpdate =
  | Readonly<{ kind: 'updated'; plan: SupervisedPlan; identity: string }>
  | Readonly<{ kind: 'unavailable'; code: 'PLAN_STATUS_UNAVAILABLE' }>;

export type PlanStatusLease = Readonly<{
  statusPath: string;
  close(): void;
  remove(): Promise<void>;
}>;

/** Watches one session-private helper status file without exposing filesystem details to use cases. */
export interface PlanStatusSource {
  open(
    session: Readonly<{ id: string; workspacePath: string }>,
    listener: (update: PlanStatusUpdate) => void,
  ): Promise<PlanStatusLease>;
  remove(sessionId: string, identity?: string): Promise<void>;
  closeAll(): void;
}
