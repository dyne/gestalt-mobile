/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from './supervised-plan.js';

export type ModelPolicyStatus = 'legacy' | 'required' | 'unavailable';
export type ModelPolicyAdmission =
  | Readonly<{ allowed: true; scope: 'legacy' }>
  | Readonly<{
      allowed: false;
      code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE';
      reason:
        | 'POLICY_PROJECTION_UNAVAILABLE'
        | 'POLICY_VERSION_UNSUPPORTED'
        | 'POLICY_FIELDS_INVALID'
        | 'MODEL_PROHIBITED'
        | 'RUNTIME_ATTESTATION_UNAVAILABLE';
      action: string;
    }>;

/** Scope is automatic Org execution, not the supervisor's manual model selection or repair input. */
export function assessModelPolicyAdmission(
  plan: SupervisedPlan | null,
  status: ModelPolicyStatus = 'legacy',
): ModelPolicyAdmission {
  const blocked = (
    reason: Extract<ModelPolicyAdmission, { allowed: false }>['reason'],
  ): ModelPolicyAdmission => ({
    allowed: false,
    code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE',
    reason,
    action:
      'Keep Org automation off until a compatible runtime can attest the canonical executor settings. Manual plan review and repair remain available.',
  });
  if (status === 'unavailable') return blocked('POLICY_PROJECTION_UNAVAILABLE');
  const version = plan?.modelPolicyVersion;
  const hasPolicy = plan?.steps.some((step) => step.modelPolicy !== undefined);
  if (version === undefined && !hasPolicy && status === 'legacy')
    return { allowed: true, scope: 'legacy' };
  if (version !== 1) return blocked('POLICY_VERSION_UNSUPPORTED');
  if (!plan?.steps.length || plan.steps.some((step) => step.modelPolicy?.version !== 1))
    return blocked('POLICY_FIELDS_INVALID');
  if (
    plan.steps.some(
      (step) => !['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'].includes(step.modelPolicy!.model),
    )
  )
    return blocked('MODEL_PROHIBITED');
  // Configured settings and locally derived digests from the current adapter do
  // not satisfy the Agents runtime receipt/revision contract. No bypass flag or
  // fixture can turn this prerequisite into live admission.
  return blocked('RUNTIME_ATTESTATION_UNAVAILABLE');
}

export class ModelPolicyAdmissionError extends Error {
  readonly code = 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE';
  constructor(readonly admission: Extract<ModelPolicyAdmission, { allowed: false }>) {
    super(admission.code);
  }
}

export function requireModelPolicyAdmission(
  plan: SupervisedPlan | null,
  status?: ModelPolicyStatus,
): void {
  const admission = assessModelPolicyAdmission(plan, status);
  if (!admission.allowed) throw new ModelPolicyAdmissionError(admission);
}
