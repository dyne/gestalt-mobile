/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  assessModelPolicyAdmission,
  type ModelPolicyStatus,
} from '../domain/model-policy-admission.js';
import { currentExecutableL1Index } from '../domain/supervised-plan.js';
import {
  executionPolicyDigest,
  type ExecutorPolicyContext,
  type RuntimeExecutorConfiguration,
} from './executor-model-evidence.js';

export type RuntimePolicyCatalogRead =
  | Readonly<{
      kind: 'observed';
      source: 'runtime-model-list';
      observedAt: string;
      catalog: NonNullable<RuntimeExecutorConfiguration['catalog']>;
    }>
  | Readonly<{
      kind: 'unavailable';
      code:
        'RUNTIME_UNAVAILABLE' | 'ROOT_BINDING_MISMATCH' | 'CATALOG_UNAVAILABLE' | 'CONTEXT_CHANGED';
    }>;

/** Host-owned catalog read, independent of child existence and child settings. */
export interface RuntimePolicyCatalogReader {
  read(
    input: Readonly<{ sessionId: string; rootThreadId: string }>,
  ): Promise<RuntimePolicyCatalogRead>;
}

export type LaunchPolicyContext = ExecutorPolicyContext & { modelPolicyStatus?: ModelPolicyStatus };

/** Read-only selection evidence, never an enduring dispatch authorization or receipt. */
export class ExecutorLaunchValidationReader {
  constructor(
    private readonly context: (sessionId: string) => LaunchPolicyContext | null,
    private readonly runtime: RuntimePolicyCatalogReader,
  ) {}

  async read(sessionId: string) {
    const context = this.context(sessionId);
    if (
      !context ||
      context.sessionId !== sessionId ||
      context.provider !== 'codex' ||
      context.plan?.modelPolicyVersion !== 1
    )
      return null;
    const index = currentExecutableL1Index(context.plan);
    const step = context.plan.steps[index];
    const policy = step?.modelPolicy;
    if (!policy) return null;
    const admission = assessModelPolicyAdmission(context.plan, context.modelPolicyStatus);
    const l1Id = Buffer.byteLength(JSON.stringify(step.id), 'utf8') <= 96 ? step.id : null;
    const report = {
      scope: 'prelaunch-catalog' as const,
      assurance: context.plan.modelPolicyAssurance ?? 'configured',
      l1: { id: l1Id, position: index + 1 },
      policyDigest: executionPolicyDigest(policy),
      requested: { model: policy.model, reasoningEffort: policy.reasoningEffort },
      validated: false,
      code: 'CATALOG_UNAVAILABLE' as string,
      catalog: null as {
        source: 'runtime-model-list';
        fingerprint: string;
        revisionSource: 'normalized-content-digest';
        observedAt: string;
      } | null,
      runtimeEnforcement: false as const,
      action:
        'Read the active runtime catalog through health; child catalogRevision is not a prelaunch prerequisite.',
    };
    const finish = (code: string, action: string) => ({ ...report, code, action });
    if (!admission.allowed) return finish(admission.reason, admission.action);
    if (!context.rootThreadId || !context.planIdentity || !l1Id)
      return finish(
        'ROOT_BINDING_MISMATCH',
        'Restore the owning root/session binding before validating launch settings.',
      );
    const before = launchFence(context);
    let result: RuntimePolicyCatalogRead;
    try {
      result = await this.runtime.read({ sessionId, rootThreadId: context.rootThreadId });
    } catch {
      return finish(
        'CATALOG_UNAVAILABLE',
        'The active runtime model/list read failed; inspect its capability without inventing catalog evidence.',
      );
    }
    if (launchFence(this.context(sessionId)) !== before)
      return finish(
        'CONTEXT_CHANGED',
        'Plan, policy or root ownership changed during the read; refresh health once before launch.',
      );
    if (result.kind !== 'observed')
      return finish(
        result.code,
        'The owning runtime catalog is unavailable; inspect the returned capability/binding code. No child receipt is required.',
      );
    report.catalog = {
      source: result.source,
      fingerprint: result.catalog.revision,
      revisionSource: 'normalized-content-digest',
      observedAt: result.observedAt,
    };
    const available = result.catalog.models.find((model) => model.id === policy.model);
    if (!available)
      return finish(
        'MODEL_UNAVAILABLE',
        'The runtime catalog does not support the requested exact model. Do not substitute a fallback silently.',
      );
    if (!available.reasoningEfforts.includes(policy.reasoningEffort))
      return finish(
        'EFFORT_UNSUPPORTED',
        'The runtime catalog does not support the requested effort. Do not change effort silently.',
      );
    report.validated = true;
    return finish(
      'CATALOG_MATCH',
      'Requested model/effort are supported by the owning runtime catalog. Proceed with the validated launch recipe within current controller authority; child settings remain unknown until observed.',
    );
  }
}

function launchFence(context: LaunchPolicyContext | null): string {
  const index = context?.plan ? currentExecutableL1Index(context.plan) : -1;
  const step = context?.plan?.steps[index];
  return JSON.stringify([
    context?.sessionId,
    context?.provider,
    context?.rootThreadId,
    context?.planIdentity,
    context?.plan?.modelPolicyVersion,
    context?.modelPolicyStatus,
    context?.plan?.modelPolicyAssurance ?? 'configured',
    index,
    step?.id,
    step?.state,
    step?.modelPolicy ? executionPolicyDigest(step.modelPolicy) : null,
  ]);
}
