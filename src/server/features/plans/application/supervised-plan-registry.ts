/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PlanStatusUpdate } from './ports.js';
import type { SupervisedPlan } from '../domain/supervised-plan.js';

/** Retains at most one validated plan projection for each relay session. */
export class SupervisedPlanRegistry {
  private readonly plans = new Map<string, Readonly<{ plan: SupervisedPlan; identity: string }>>();

  accept(sessionId: string, update: PlanStatusUpdate): void {
    if (update.kind === 'updated') this.plans.set(sessionId, { plan: update.plan, identity: update.identity });
  }

  find(sessionId: string): SupervisedPlan | null {
    return this.plans.get(sessionId)?.plan ?? null;
  }

  identity(sessionId: string): string | null {
    return this.plans.get(sessionId)?.identity ?? null;
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }
}
