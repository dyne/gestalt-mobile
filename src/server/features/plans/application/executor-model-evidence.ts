/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { parseOrgPlanAgentIdentity } from '../../../../shared/org-plan-position.js';
import type { ExecutorLifecycle } from '../../autopilot/domain/supervised-lifecycle.js';
import {
  currentExecutableL1Index,
  type PlanModelPolicy,
  type SupervisedPlan,
} from '../domain/supervised-plan.js';

export type RuntimeExecutorConfiguration = Readonly<{
  source: 'runtime-thread-metadata';
  observationId: string;
  observedAt: string;
  model: string | null;
  reasoningEffort: string | null;
  role: string | null;
  /** The current protocol supplies configured settings, not a runtime revision/receipt. */
  settingsRevision: null;
  settingsFingerprint: string;
  catalog: Readonly<{
    source: 'runtime';
    /** Local digest of the normalized authoritative catalog, not a server revision. */
    revision: string;
    models: readonly Readonly<{ id: string; reasoningEfforts: readonly string[] }>[];
  }> | null;
}>;
export type ExecutorConfigurationRead =
  | Readonly<{ kind: 'observed'; configuration: RuntimeExecutorConfiguration }>
  | Readonly<{
      kind: 'unavailable';
      code:
        | 'RUNTIME_UNAVAILABLE'
        | 'CHILD_BINDING_UNKNOWN'
        | 'CHILD_BINDING_MISMATCH'
        | 'CHILD_NOT_LOADED'
        | 'OBSERVATION_CHANGED';
    }>;

/** Host-only port; model-owned tool arguments never populate this evidence. */
export interface ExecutorConfigurationReader {
  read(
    input: Readonly<{
      sessionId: string;
      rootThreadId: string;
      threadId: string;
      taskPath: string;
    }>,
  ): Promise<ExecutorConfigurationRead>;
}
export type ExecutorPolicyContext = Readonly<{
  sessionId: string;
  provider: 'codex' | 'kimi';
  rootThreadId: string | null;
  planIdentity: string | null;
  plan: SupervisedPlan | null;
  executor: ExecutorLifecycle | null;
}>;

/** Same execution-only digest as Agents; lifecycle/prose changes do not select a new model. */
export function executionPolicyDigest(policy: PlanModelPolicy): string {
  const canonical = (value: unknown): unknown =>
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map(canonical)
        : Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
      : value;
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          version: policy.version,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
          necessity: policy.necessity,
        }),
      ),
    )
    .digest('hex');
}

const small = (value: string | null | undefined, bytes = 96): string | null =>
  typeof value === 'string' &&
  value.trim() &&
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes
    ? value
    : null;

/** One current, bounded observation. It never admits work or changes runtime settings. */
export class ExecutorModelEvidenceReader {
  constructor(
    private readonly context: (sessionId: string) => ExecutorPolicyContext | null,
    private readonly runtime: ExecutorConfigurationReader,
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
    const executor = context.executor;
    const identity = executor ? parseOrgPlanAgentIdentity(executor.taskPath) : null;
    const child = {
      threadId: small(executor?.threadId),
      generation: identity?.generation ?? null,
      continuationCount: executor?.continuationCount ?? null,
      observationId: null as string | null,
    };
    const report = {
      version: 1,
      l1: { id: small(step.id), position: index + 1 },
      policyDigest: executionPolicyDigest(policy),
      requested: { model: policy.model, reasoningEffort: policy.reasoningEffort },
      effective: { model: null as string | null, reasoningEffort: null as string | null },
      observedRole: null as string | null,
      child,
      source: null as 'runtime-thread-metadata' | null,
      evidenceScope: 'configured-thread-settings' as const,
      observedAt: null as string | null,
      settingsRevision: null,
      settingsFingerprint: null as string | null,
      catalogRevision: null as string | null,
      catalogRevisionSource: 'normalized-content-digest' as const,
      configuration: 'unknown' as 'unknown' | 'match' | 'mismatch',
      admitted: false as const,
      attested: false as const,
      admissionScope: 'runtime-attestation' as const,
      runtimeEnforcement: false as const,
      assurance: context.plan.modelPolicyAssurance ?? 'configured',
      code: 'CHILD_BINDING_UNKNOWN' as string,
      action:
        'Child-only evidence. Use executorLaunch for prelaunch catalog validation; this report is not launch admission.',
      unknown: [] as string[],
    };
    const finish = (code: string) => {
      report.code = code;
      report.unknown = [
        ...Object.entries(report.effective)
          .filter(([, value]) => value === null)
          .map(([key]) => `effective.${key}`),
        ...(report.child.threadId === null ? ['child.threadId'] : []),
        ...(report.catalogRevision === null ? ['catalogRevision'] : []),
        ...(report.observedAt === null ? ['observedAt'] : []),
        'settingsRevision',
      ];
      return report;
    };
    if (!executor) return finish('CHILD_NOT_LAUNCHED');
    if (
      !identity ||
      !context.rootThreadId ||
      !context.planIdentity ||
      !child.threadId ||
      !report.l1.id ||
      executor.threadId === context.rootThreadId ||
      identity.canonicalPosition !== `L${index + 1}` ||
      executor.canonicalPosition !== identity.canonicalPosition ||
      executor.canonicalTaskName !== identity.canonicalTaskName ||
      executor.continuationGeneration !== identity.generation ||
      executor.assignment?.state === 'closed' ||
      executor.assignment?.state === 'unavailable' ||
      executor.replacement ||
      (executor.assignment &&
        (executor.assignment.threadId !== executor.threadId ||
          executor.assignment.taskPath !== executor.taskPath ||
          executor.assignment.generation !== identity.generation))
    )
      return finish('CONTROLLER_BINDING_INVALID');
    const fence = contextFence(context);
    let result: ExecutorConfigurationRead;
    try {
      result = await this.runtime.read({
        sessionId,
        rootThreadId: context.rootThreadId,
        threadId: executor.threadId,
        taskPath: executor.taskPath,
      });
    } catch {
      return finish('RUNTIME_UNAVAILABLE');
    }
    if (contextFence(this.context(sessionId)) !== fence) return finish('CONTEXT_CHANGED');
    if (result.kind !== 'observed') return finish(result.code);
    const observed = result.configuration;
    report.source = observed.source;
    report.child.observationId = small(observed.observationId);
    report.observedAt = small(observed.observedAt, 40);
    report.settingsFingerprint = small(observed.settingsFingerprint);
    report.effective.model = small(observed.model, 64);
    report.effective.reasoningEffort = small(observed.reasoningEffort, 24);
    report.observedRole = small(observed.role, 64);
    report.catalogRevision = small(observed.catalog?.revision);
    if (report.observedRole && !['default', 'org-plan-executor'].includes(report.observedRole)) {
      report.configuration = 'mismatch';
      return finish('ROLE_MISMATCH');
    }
    if (report.effective.model !== null && report.effective.model !== policy.model) {
      report.configuration = 'mismatch';
      return finish('MODEL_MISMATCH');
    }
    if (
      report.effective.reasoningEffort !== null &&
      report.effective.reasoningEffort !== policy.reasoningEffort
    ) {
      report.configuration = 'mismatch';
      return finish('EFFORT_MISMATCH');
    }
    if (!observed.catalog) return finish('CATALOG_UNKNOWN');
    const available = observed.catalog.models.find((model) => model.id === policy.model);
    if (!available || !available.reasoningEfforts.includes(policy.reasoningEffort)) {
      report.configuration = 'mismatch';
      return finish(!available ? 'MODEL_UNAVAILABLE' : 'EFFORT_UNSUPPORTED');
    }
    if (
      !report.effective.model ||
      !report.effective.reasoningEffort ||
      !report.observedAt ||
      !report.child.observationId
    )
      return finish('RUNTIME_SETTINGS_UNKNOWN');
    report.configuration = 'match';
    return finish('RUNTIME_REVISION_UNKNOWN');
  }
}

function contextFence(context: ExecutorPolicyContext | null): string {
  const index = context?.plan ? currentExecutableL1Index(context.plan) : -1;
  const step = context?.plan?.steps[index];
  const executor = context?.executor;
  return JSON.stringify({
    sessionId: context?.sessionId,
    provider: context?.provider,
    root: context?.rootThreadId,
    plan: context?.planIdentity,
    policyVersion: context?.plan?.modelPolicyVersion,
    assurance: context?.plan?.modelPolicyAssurance,
    l1: step?.id,
    state: step?.state,
    policy: step?.modelPolicy ? executionPolicyDigest(step.modelPolicy) : null,
    child: executor
      ? [
          executor.threadId,
          executor.taskPath,
          executor.continuationGeneration,
          executor.continuationCount,
          executor.assignment,
          executor.replacement,
        ]
      : null,
  });
}
