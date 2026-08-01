/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../domain/supervised-plan.js';
import type { PlanMeasurementSnapshot } from './measurement-snapshot.js';

export type PlanStatusUpdate =
  | Readonly<{
      kind: 'updated';
      plan: SupervisedPlan;
      identity: string;
      planPath: string;
      reason: PlanSignalReason | null;
    }>
  | Readonly<{ kind: 'unavailable'; code: 'PLAN_STATUS_UNAVAILABLE' }>;

export type PlanSignalReason = 'authoring-start' | 'work-start' | 'checkpoint' | 'update';

export type PlanStatusLease = Readonly<{
  statusDirectory: string;
  close(): void;
  remove(): Promise<void>;
}>;

/** Watches one session-private helper status directory without exposing filesystem details to use cases. */
export interface PlanStatusSource {
  open(
    session: Readonly<{ id: string; workspacePath: string }>,
    listener: (update: PlanStatusUpdate) => void,
  ): Promise<PlanStatusLease>;
  remove(sessionId: string, identity?: string): Promise<void>;
  closeAll(): void;
}

/** Supplies one session's measurement data without exposing Codex wire types. */
export interface PlanMeasurementSnapshotSource {
  read(sessionId: string): Promise<PlanMeasurementSnapshot>;
}
