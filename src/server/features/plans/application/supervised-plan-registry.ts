/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PlanStatusUpdate } from './ports.js';
import type { SupervisedPlan } from '../domain/supervised-plan.js';
import type { ModelPolicyStatus } from '../domain/model-policy-admission.js';

/** Retains at most one validated plan projection for each relay session. */
export class SupervisedPlanRegistry {
  private readonly policyUnavailable = new Set<string>();
  private readonly currentUnavailable = new Set<string>();
  private readonly plans = new Map<
    string,
    Readonly<{ plan: SupervisedPlan; identity: string; publicationReason: string | null }>
  >();

  accept(sessionId: string, update: PlanStatusUpdate): void {
    if (update.kind === 'updated') {
      this.plans.set(sessionId, {
        plan: update.plan,
        identity: update.identity,
        publicationReason: update.reason,
      });
      this.policyUnavailable.delete(sessionId);
      this.currentUnavailable.delete(sessionId);
    } else {
      this.currentUnavailable.add(sessionId);
      if (update.modelPolicyRequired || this.find(sessionId)?.modelPolicyVersion === 1)
        this.policyUnavailable.add(sessionId);
    }
  }

  /** An invalid mandatory publication cannot silently reuse a legacy execution policy. */
  modelPolicyStatus(sessionId: string): ModelPolicyStatus {
    return this.policyUnavailable.has(sessionId)
      ? 'unavailable'
      : this.find(sessionId)?.modelPolicyVersion === 1
        ? 'required'
        : 'legacy';
  }

  find(sessionId: string): SupervisedPlan | null {
    return this.plans.get(sessionId)?.plan ?? null;
  }

  /** Retained display state cannot authorize a capability after an invalid publication. */
  findCurrent(sessionId: string): SupervisedPlan | null {
    return this.currentUnavailable.has(sessionId) ? null : this.find(sessionId);
  }

  identity(sessionId: string): string | null {
    return this.plans.get(sessionId)?.identity ?? null;
  }

  publicationReason(sessionId: string): string | null {
    return this.plans.get(sessionId)?.publicationReason ?? null;
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
    this.policyUnavailable.delete(sessionId);
    this.currentUnavailable.delete(sessionId);
  }
}
