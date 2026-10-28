/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { PlanStep, SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { currentExecutableL1Index } from '../../plans/domain/supervised-plan.js';
import type { ExecutorModelEvidenceReader } from '../../plans/application/executor-model-evidence.js';
import type { ExecutorLaunchValidationReader } from '../../plans/application/executor-launch-validation.js';
import type { AutopilotSnapshot } from '../domain/autopilot-session.js';
import type { SupervisionProtocolState } from '../domain/supervision-protocol.js';
import type { HostTestResult } from '../../../../shared/contracts/host-tests.js';
import { executionComplete } from './policy.js';

export type HostRunSummary = Readonly<{
  enabled: boolean;
  running: number;
  unread: number;
  omitted: number;
  runs: readonly Pick<HostTestResult, 'runId' | 'suite' | 'state'>[];
}>;

type Input = Readonly<{
  autopilot: AutopilotSnapshot;
  plan: SupervisedPlan | null;
  planIdentity: string | null;
  activity: AgentActivitySnapshot;
  pendingInteractions: number;
  tests: HostRunSummary;
  wait: SupervisionProtocolState['waitLease'];
  binding: { status: string; code: string } | null;
  modelPolicy: Awaited<ReturnType<ExecutorModelEvidenceReader['read']>>;
  launch: Awaited<ReturnType<ExecutorLaunchValidationReader['read']>>;
}>;

const id = (value: string | null | undefined) => (value && value.length <= 128 ? value : null);

function planRevision(plan: SupervisedPlan): string {
  const step = (value: PlanStep): unknown => ({
    id: value.id,
    title: value.title,
    state: value.state,
    priority: value.priority,
    reviewStatus: value.reviewStatus,
    skills: value.skills,
    description: value.description,
    modelPolicy: value.modelPolicy,
    children: value.children.map(step),
  });
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: plan.title,
        subtitle: plan.subtitle,
        date: plan.date,
        keywords: plan.keywords,
        modelPolicyVersion: plan.modelPolicyVersion,
        modelPolicyAssurance: plan.modelPolicyAssurance,
        steps: plan.steps.map(step),
      }),
    )
    .digest('hex');
}

/** No prose, command history, observation clocks or source paths enter the compact read model. */
export function compactSupervisionSnapshot(input: Input) {
  const { autopilot: a, activity, modelPolicy: m, launch: l } = input;
  const parent = input.plan?.steps[currentExecutableL1Index(input.plan)];
  const barrier = input.plan?.steps.find((step) => step.state === 'SUSPENDED');
  const child = parent?.children.find(
    (step) => step.id === input.plan?.currentStepId || step.state === 'WIP',
  );
  const priority = (agent: AgentActivitySnapshot['subagents'][number]) =>
    (agent.threadId ?? agent.id) === a.executor?.threadId
      ? 0
      : ['working', 'awaitingAgent', 'awaitingHuman', 'blocked'].includes(agent.state)
        ? 1
        : 2;
  const agents = [...activity.subagents].sort(
    (left, right) => priority(left) - priority(right) || left.id.localeCompare(right.id),
  );
  const admission = a.executionAdmission;
  return {
    control: {
      state: a.state,
      enabled: a.enabled,
      healthy: a.health.healthy,
      phase: a.health.phase,
      supervision: a.health.supervision,
      reason: a.reason ?? null,
      next: a.health.nextExpectedAction,
      pendingInteractions: input.pendingInteractions,
    },
    plan: input.plan
      ? {
          identity: id(input.planIdentity),
          revision: planRevision(input.plan),
          currentStepId: id(input.plan.currentStepId),
          l1: parent
            ? { id: id(parent.id), state: parent.state, review: parent.reviewStatus ?? null }
            : null,
          l2: child ? { id: id(child.id), state: child.state } : null,
          barrier: barrier ? { id: id(barrier.id), state: barrier.state } : null,
          done: input.plan.doneSteps,
          total: input.plan.totalSteps,
          complete: executionComplete(input.plan),
        }
      : null,
    executor: a.executor
      ? {
          threadId: id(a.executor.threadId),
          position: id(a.executor.canonicalPosition),
          generation: a.executor.continuationGeneration,
          outcome: a.executor.outcome,
        }
      : null,
    activity: {
      confidence: activity.confidence,
      root: activity.root.state,
      aggregate: activity.aggregateSubagents,
      total: agents.length,
      agents: agents.slice(0, 8).map((agent) => ({
        id: id(agent.id),
        threadId: id(agent.threadId),
        position: id(agent.canonicalPosition),
        state: agent.state,
        reason: agent.reason,
      })),
      omitted: Math.max(0, agents.length - 8),
    },
    admission: admission
      ? admission.allowed
        ? {
            allowed: true,
            scope: admission.scope,
            runtimeEnforcement: admission.scope === 'configured' ? false : null,
          }
        : { allowed: false, code: admission.code, reason: admission.reason }
      : null,
    binding: input.binding,
    modelPolicy: m
      ? {
          code: m.code,
          configuration: m.configuration,
          requested: m.requested,
          effective: m.effective,
          assurance: m.assurance,
          attested: m.attested,
          runtimeEnforcement: m.runtimeEnforcement,
        }
      : null,
    launch: l
      ? {
          code: l.code,
          requested: l.requested,
          validated: l.validated,
          assurance: l.assurance,
          runtimeEnforcement: l.runtimeEnforcement,
        }
      : null,
    tests: input.tests,
    wait: input.wait
      ? {
          leaseId: id(input.wait.id),
          runId: input.wait.runId ?? null,
          resumeAt: input.wait.resumeAt ?? null,
          conditions: input.wait.wakeConditions,
        }
      : null,
  };
}

export type CompactSupervisionSnapshot = ReturnType<typeof compactSupervisionSnapshot>;

/** Bounded session-scoped history. A cache miss returns a full view, never a guessed delta. */
export class SupervisionSnapshots {
  private readonly sessions = new Map<string, Map<string, CompactSupervisionSnapshot>>();

  read(sessionId: string, snapshot: CompactSupervisionSnapshot, sinceRevision?: string) {
    const stable = structuredClone(snapshot);
    const revision = createHash('sha256')
      .update(sessionId)
      .update('\0')
      .update(JSON.stringify(stable))
      .digest('hex');
    const history = this.sessions.get(sessionId) ?? new Map<string, CompactSupervisionSnapshot>();
    const previous = sinceRevision ? history.get(sinceRevision) : undefined;
    history.set(revision, stable);
    while (history.size > 8) history.delete(history.keys().next().value!);
    this.sessions.set(sessionId, history);
    while (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value!);
    if (sinceRevision === revision) return { revision, unchanged: true as const };
    if (previous)
      return {
        revision,
        unchanged: false as const,
        changes: Object.fromEntries(
          Object.entries(stable).filter(
            ([key, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(previous[key as keyof CompactSupervisionSnapshot]),
          ),
        ),
      };
    return { revision, unchanged: false as const, reset: Boolean(sinceRevision), snapshot: stable };
  }
}
