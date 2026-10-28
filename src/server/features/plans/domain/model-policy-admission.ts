/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { validPlanModel, validPlanEffort, type SupervisedPlan } from './supervised-plan.js';

export type ModelPolicyStatus = 'legacy' | 'required' | 'unavailable';
export type ModelPolicyAdmission =
  | Readonly<{ allowed: true; scope: 'legacy' }>
  | Readonly<{
      allowed: true;
      scope: 'configured';
      assurance: 'configured';
      runtimeEnforcement: false;
      action: string;
    }>
  | Readonly<{
      allowed: false;
      code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE';
      reason:
        | 'POLICY_PROJECTION_UNAVAILABLE'
        | 'POLICY_VERSION_UNSUPPORTED'
        | 'POLICY_FIELDS_INVALID'
        | 'MODEL_PROHIBITED'
        | 'EFFORT_UNSUPPORTED'
        | 'ASSURANCE_UNSUPPORTED'
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
      reason === 'RUNTIME_ATTESTATION_UNAVAILABLE'
        ? 'This plan explicitly requires runtime-attested assurance. This adapter has no settings receipt/revision API. Use a runtime with attestation support, or explicitly authorize changing MODEL_POLICY_ASSURANCE to configured; repeating approval cannot provide attestation.'
        : 'Repair the plan policy or its publication, then retry supervision. Manual Off and user authorization are separate from policy admission.',
  });
  if (status === 'unavailable') return blocked('POLICY_PROJECTION_UNAVAILABLE');
  const version = plan?.modelPolicyVersion;
  const hasPolicy = plan?.steps.some((step) => step.modelPolicy !== undefined);
  if (version === undefined && !hasPolicy && status === 'legacy')
    return { allowed: true, scope: 'legacy' };
  if (version !== 1) return blocked('POLICY_VERSION_UNSUPPORTED');
  if (!plan?.steps.length || plan.steps.some((step) => step.modelPolicy?.version !== 1))
    return blocked('POLICY_FIELDS_INVALID');
  if (plan.steps.some((step) => !validPlanModel(step.modelPolicy!.model)))
    return blocked('MODEL_PROHIBITED');
  if (
    plan.steps.some((step) => {
      const policy = step.modelPolicy!;
      const necessity = policy.necessity;
      return (
        !validPlanEffort(policy.reasoningEffort) ||
        (policy.reasoningEffort === 'medium'
          ? necessity !== null
          : necessity !== null &&
            (!necessity ||
              !['unresolved-correctness', 'specific-reasoning'].includes(necessity.kind) ||
              ![
                necessity.whyMediumInadequate,
                necessity.evidence,
                necessity.affectedScope,
                necessity.returnToMedium,
                ...(policy.reasoningEffort === 'xhigh' ? [necessity.scopeReassessment] : []),
              ].every((value) => typeof value === 'string' && value.trim())))
      );
    })
  )
    return blocked('EFFORT_UNSUPPORTED');
  const assurance = plan.modelPolicyAssurance ?? 'configured';
  if (!['configured', 'runtime-attested'].includes(assurance))
    return blocked('ASSURANCE_UNSUPPORTED');
  if (assurance === 'runtime-attested') return blocked('RUNTIME_ATTESTATION_UNAVAILABLE');
  return {
    allowed: true,
    scope: 'configured',
    assurance: 'configured',
    runtimeEnforcement: false,
    action:
      'Compatibility mode: validate the supervisor-selected L1 settings against the runtime catalog and preserve controller-owned executor identity. Apply changed settings at the next safe turn, never repin them to session defaults. Missing observations remain unknown; no runtime attestation is claimed.',
  };
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
