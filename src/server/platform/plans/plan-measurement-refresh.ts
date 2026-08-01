/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PlanMeasurementSnapshot } from '../../features/plans/application/measurement-snapshot.js';
import type { PlanStatusUpdate } from '../../features/plans/application/ports.js';
import type { PlanStep, SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';

export const PLAN_MEASUREMENT_REFRESH_MS = 60_000;

type ActivePlanMeasurement = Readonly<{ planPath: string; stepId: string }>;

/**
 * Refreshes the current WIP step at a bounded cadence. A refresh is deliberately
 * owned by the session that owns the plan, so replacing, closing, or stopping a
 * session cannot leave a timer writing another session's plan.
 */
export class PlanMeasurementRefresh {
  private readonly active = new Map<string, ActivePlanMeasurement>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly readSnapshot: (sessionId: string) => Promise<PlanMeasurementSnapshot>,
    private readonly checkpoint: (
      planPath: string,
      stepId: string,
      snapshot: PlanMeasurementSnapshot,
    ) => Promise<void>,
  ) {}

  accept(sessionId: string, update: PlanStatusUpdate): void {
    const next = activeMeasurement(update);
    if (!next) return this.stop(sessionId);
    const current = this.active.get(sessionId);
    this.active.set(sessionId, next);
    if (current?.planPath === next.planPath && current.stepId === next.stepId) return;
    this.clearTimer(sessionId);
    this.schedule(sessionId);
  }

  stop(sessionId: string): void {
    this.active.delete(sessionId);
    this.clearTimer(sessionId);
  }

  stopAll(): void {
    for (const sessionId of this.active.keys()) this.stop(sessionId);
  }

  private schedule(sessionId: string): void {
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.refresh(sessionId);
      }, PLAN_MEASUREMENT_REFRESH_MS),
    );
  }

  private async refresh(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active || this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    try {
      await this.checkpoint(active.planPath, active.stepId, await this.readSnapshot(sessionId));
    } catch {
      // A transient Codex or helper failure makes this tick unavailable only.
    } finally {
      this.inFlight.delete(sessionId);
      if (this.active.get(sessionId) === active && !this.timers.has(sessionId)) this.schedule(sessionId);
    }
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}

function activeMeasurement(update: PlanStatusUpdate): ActivePlanMeasurement | null {
  if (update.kind !== 'updated') return null;
  const step = findStep(update.plan, update.plan.currentStepId);
  return step?.state === 'WIP' ? { planPath: update.planPath, stepId: step.id } : null;
}

function findStep(plan: SupervisedPlan, id: string): PlanStep | undefined {
  const visit = (steps: readonly PlanStep[]): PlanStep | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      const child = visit(step.children);
      if (child) return child;
    }
    return undefined;
  };
  return visit(plan.steps);
}
