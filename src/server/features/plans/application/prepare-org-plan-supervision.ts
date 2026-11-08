/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  OrgPlanPreparation,
  OrgPlanReference,
  OrgPlanWorkspace,
} from '../../../../shared/contracts/org-plan-execution.js';
import type { SupervisedPlan, PlanUnavailableReason } from '../domain/supervised-plan.js';
import { assessModelPolicyAdmission } from '../domain/model-policy-admission.js';
import type { OrgPlanSettingsRead } from './prepare-org-plan-settings.js';

/** Filesystem identity and revision deliberately live outside SupervisedPlan. */
export type ExecutionPlanRead =
  | Readonly<{ kind: 'available'; plan: SupervisedPlan; canonicalPath: string; revision: string }>
  | Readonly<{ kind: 'invalid'; reason: PlanUnavailableReason }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;

export type PrepareOrgPlanDependencies = {
  resolveReference(
    reference: OrgPlanReference,
  ): Promise<{ workspacePath: string; planName: string } | null>;
  read(workspacePath: string, planName: string): Promise<ExecutionPlanRead>;
  workspace(
    canonicalPath: string,
    fileRevision: string,
  ): Promise<{ workspace: OrgPlanWorkspace; revision: string } | null>;
  runtimeAvailable(): Promise<boolean>;
  owner(canonicalPath: string): Promise<{ sessionId: string } | null>;
  policy(plan: SupervisedPlan): ReturnType<typeof assessModelPolicyAdmission>;
  settings(workspacePath: string, skillProfile?: string): Promise<OrgPlanSettingsRead>;
};

/** Read-only admission: no session creation, turn submission or activating attachment ports. */
export async function prepareOrgPlanSupervision(
  reference: OrgPlanReference,
  deps: PrepareOrgPlanDependencies,
  expectedRevision?: string,
  skillProfile?: string,
): Promise<OrgPlanPreparation> {
  const blocked = (
    code: Extract<OrgPlanPreparation, { kind: 'blocked' }>['code'],
    reason: string,
  ): OrgPlanPreparation => ({ kind: 'blocked', code, reason });
  const changed = () =>
    blocked(
      'CONTEXT_CHANGED',
      'The plan file or project context changed. Refresh the plan and confirm again.',
    );
  let resolved: Awaited<ReturnType<PrepareOrgPlanDependencies['resolveReference']>>;
  try {
    resolved = await deps.resolveReference(reference);
  } catch {
    resolved = null;
  }
  if (!resolved && expectedRevision) return changed();
  if (!resolved)
    return blocked(
      'REFERENCE_UNAVAILABLE',
      'The plan workspace or session is no longer available.',
    );
  let file: ExecutionPlanRead;
  try {
    file = await deps.read(resolved.workspacePath, resolved.planName);
  } catch {
    if (expectedRevision) return changed();
    return blocked('PLAN_UNREADABLE', 'The plan cannot be read safely.');
  }
  if (file.kind !== 'available' && expectedRevision) return changed();
  if (file.kind === 'missing') return blocked('PLAN_NOT_FOUND', 'The plan file no longer exists.');
  if (file.kind === 'unavailable')
    return blocked('PLAN_UNREADABLE', 'The plan cannot be read safely.');
  if (file.kind === 'invalid')
    return blocked(
      'INVALID_PLAN',
      `This Org document is not a valid Gestalt plan (${file.reason}).`,
    );
  let context: Awaited<ReturnType<PrepareOrgPlanDependencies['workspace']>>;
  try {
    context = await deps.workspace(file.canonicalPath, file.revision);
  } catch {
    context = null;
  }
  if (!context)
    return expectedRevision
      ? changed()
      : blocked('WORKSPACE_UNAVAILABLE', 'The plan has no permitted project workspace.');
  if (expectedRevision && context.revision !== expectedRevision) return changed();
  if (file.plan.executionComplete)
    return blocked('NO_REMAINING_WORK', 'Every plan step is complete and reviewed.');
  const policy = deps.policy(file.plan);
  if (!policy.allowed) return blocked('MODEL_POLICY_UNAVAILABLE', policy.action);
  try {
    const owner = await deps.owner(file.canonicalPath);
    if (owner)
      return {
        kind: 'blocked',
        code: 'ACTIVE_SUPERVISION',
        reason: 'This plan already has a supervisor. Open its session to continue or recover it.',
        existingSessionId: owner.sessionId,
      };
    if (!(await deps.runtimeAvailable()))
      return blocked('CODEX_UNAVAILABLE', 'Codex supervision is currently unavailable.');
  } catch {
    return blocked(
      'CODEX_UNAVAILABLE',
      'Supervision availability could not be verified. Retry after refreshing.',
    );
  }
  const settings = await deps.settings(context.workspace.path, skillProfile);
  if (settings.kind !== 'available') return blocked(settings.code, settings.reason);
  return {
    kind: 'eligible',
    reference,
    title: file.plan.title,
    sourcePath: file.canonicalPath,
    workspace: context.workspace,
    revision: context.revision,
    settings: settings.settings,
    skillProfiles: settings.skillProfiles,
    warnings: settings.warnings,
  };
}
