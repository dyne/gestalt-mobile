/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { orgPlanAgentDisplayName } from '../../../../shared/org-plan-position.js';
import {
  parseSupervisionProtocolState,
  type SupervisionProtocolState,
} from './supervision-protocol.js';

export type ExecutorOutcome = 'objective_complete' | 'partial' | 'blocked' | 'cancelled' | 'failed';

export type BlockingReason =
  | 'planChange'
  | 'hardBlock'
  | 'missingDependency'
  | 'permissionRequired'
  | 'externalState'
  | 'materialAmbiguity';

export type ResumeCondition =
  | 'planRevision'
  | 'externalStateChanged'
  | 'dependencyInstalled'
  | 'permissionGranted'
  | 'userGuidance';

export const blockingResumeConditions: Readonly<Record<BlockingReason, ResumeCondition>> = {
  planChange: 'planRevision',
  hardBlock: 'externalStateChanged',
  missingDependency: 'dependencyInstalled',
  permissionRequired: 'permissionGranted',
  externalState: 'externalStateChanged',
  materialAmbiguity: 'userGuidance',
};

export type StructuredBlock = Readonly<{
  reason: BlockingReason;
  resumeCondition: ResumeCondition;
}>;

export type OwnedExecutorProcess = Readonly<{
  processId: string;
  itemId: string;
  ownerThreadId: string;
  ownerTaskPath: string;
  ownership: 'executor' | 'supervisor';
  state:
    | 'running'
    | 'detached-active'
    | 'exited-awaiting-result'
    | 'result-consumed'
    | 'terminated-for-budget';
  observedAt: string;
  elapsedMs: number;
  cpuPercent: number | null;
  rssBytes: number | null;
  osPid?: number;
  exitStatus?: number;
  resultArtifact?: string;
}>;

export type ExecutorLifecycle = Readonly<{
  canonicalPosition: string;
  canonicalTaskName: string;
  taskPath: string;
  threadId: string;
  l1State: 'TODO' | 'WIP' | 'DONE';
  l2State?: 'TODO' | 'WIP' | 'DONE';
  lastActivityAt: string;
  ownedProcesses: readonly OwnedExecutorProcess[];
  outcome: ExecutorOutcome;
  blocking?: StructuredBlock;
  continuationGeneration: number;
  continuationCount: number;
}>;

export type PersistedSupervisedLifecycle = Readonly<{
  executor?: ExecutorLifecycle;
  blocking?: StructuredBlock;
  supervision?: SupervisionProtocolState;
  checkpoints?: Readonly<{
    protocolVersion: 1;
    planIdentity: string;
    reportedL1Ids: readonly string[];
    acceptedKeys: readonly string[];
    pendingTurnId: string | null;
    terminalReviewAccepted: boolean;
  }>;
}>;

export type ExecutorIdentity = Readonly<{
  canonicalTaskName: string;
  canonicalPosition: string;
  generation: number;
  taskName: string;
}>;

export type SupervisedLifecycleEvent =
  | 'executorTurnEnded'
  | 'checkpoint'
  | 'waitTimeout'
  | 'userStatusAnswered'
  | 'rootFinalAttempt'
  | 'processObserved'
  | 'processExited'
  | 'stateChanged';

export type SupervisedLifecyclePolicy = Readonly<{
  continuationBaseDelayMs: number;
  continuationMaxDelayMs: number;
  processPollMs: number;
  processMaxElapsedMs: number;
  processMaxRssBytes: number;
}>;

export type SupervisedLifecycleInput = Readonly<{
  plan: SupervisedPlan;
  event: SupervisedLifecycleEvent;
  executor?: ExecutorLifecycle;
  attention?: StructuredBlock;
  explicitlyPausedOrCancelled?: boolean;
  now: string;
  policy: SupervisedLifecyclePolicy;
}>;

export type SupervisedLifecycleDecision = Readonly<{
  finalAllowed: boolean;
  action:
    | Readonly<{ kind: 'allowFinal' }>
    | Readonly<{ kind: 'reinspect' }>
    | Readonly<{ kind: 'continueSupervisor' }>
    | Readonly<{
        kind: 'invokeAttention';
        reason: BlockingReason;
        resumeCondition: ResumeCondition;
      }>
    | Readonly<{
        kind: 'resumeExecutor';
        threadId: string;
        generation: number;
        delayMs: number;
      }>
    | Readonly<{ kind: 'monitorProcess'; process: OwnedExecutorProcess; pollAfterMs: number }>
    | Readonly<{
        kind: 'consumeProcessResult';
        threadId: string;
        processId: string;
        resultArtifact: string;
      }>
    | Readonly<{ kind: 'terminateProcess'; threadId: string; processId: string }>;
}>;

export function validStructuredBlock(value: StructuredBlock | undefined): value is StructuredBlock {
  return Boolean(value && blockingResumeConditions[value.reason] === value.resumeCondition);
}

export function parsePersistedSupervisedLifecycle(
  value: unknown,
): PersistedSupervisedLifecycle | undefined {
  const root = record(value);
  if (!root) return undefined;
  const blockingValue = record(root.blocking);
  const blocking = blockingValue ? parseStructuredBlock(blockingValue) : undefined;
  if (blockingValue && !blocking) return undefined;
  const executorValue = record(root.executor);
  const checkpointsValue = record(root.checkpoints);
  const supervisionValue = root.supervision;
  const supervision =
    supervisionValue === undefined ? undefined : parseSupervisionProtocolState(supervisionValue);
  if (supervisionValue !== undefined && !supervision) return undefined;
  const checkpoints = checkpointsValue ? parseCheckpoints(checkpointsValue) : undefined;
  if (checkpointsValue && !checkpoints) return undefined;
  if (!executorValue)
    return {
      ...(blocking ? { blocking } : {}),
      ...(supervision ? { supervision } : {}),
      ...(checkpoints ? { checkpoints } : {}),
    };
  const processesValue = executorValue.ownedProcesses;
  if (!Array.isArray(processesValue) || processesValue.length > 64) return undefined;
  const ownedProcesses = processesValue.flatMap((candidate) => {
    const process = record(candidate);
    if (!process) return [];
    const processId = boundedText(process.processId);
    const itemId = boundedText(process.itemId);
    const ownerThreadId = boundedText(process.ownerThreadId);
    const ownerTaskPath = boundedText(process.ownerTaskPath);
    const ownership = stringValue(process.ownership, ['executor', 'supervisor']);
    const state = stringValue(process.state, [
      'running',
      'detached-active',
      'exited-awaiting-result',
      'result-consumed',
      'terminated-for-budget',
    ]);
    const observedAt = boundedText(process.observedAt);
    const elapsedMs = nonNegativeNumber(process.elapsedMs);
    const cpuPercent = nullableNonNegativeNumber(process.cpuPercent);
    const rssBytes = nullableNonNegativeNumber(process.rssBytes);
    if (
      !processId ||
      !itemId ||
      !ownerThreadId ||
      !ownerTaskPath ||
      !ownership ||
      !state ||
      !observedAt ||
      elapsedMs === null ||
      cpuPercent === undefined ||
      rssBytes === undefined
    )
      return [];
    const osPid = nonNegativeInteger(process.osPid);
    const exitStatus = integer(process.exitStatus);
    const resultArtifact = boundedText(process.resultArtifact);
    return [
      {
        processId,
        itemId,
        ownerThreadId,
        ownerTaskPath,
        ownership,
        state,
        observedAt,
        elapsedMs,
        cpuPercent,
        rssBytes,
        ...(osPid === null ? {} : { osPid }),
        ...(exitStatus === null ? {} : { exitStatus }),
        ...(resultArtifact ? { resultArtifact } : {}),
      } satisfies OwnedExecutorProcess,
    ];
  });
  if (ownedProcesses.length !== processesValue.length) return undefined;
  const canonicalPosition = boundedText(executorValue.canonicalPosition);
  const canonicalTaskName = boundedText(executorValue.canonicalTaskName);
  const taskPath = boundedText(executorValue.taskPath);
  const threadId = boundedText(executorValue.threadId);
  const l1State = stringValue(executorValue.l1State, ['TODO', 'WIP', 'DONE']);
  const l2State = stringValue(executorValue.l2State, ['TODO', 'WIP', 'DONE']);
  const lastActivityAt = boundedText(executorValue.lastActivityAt);
  const outcome = stringValue(executorValue.outcome, [
    'objective_complete',
    'partial',
    'blocked',
    'cancelled',
    'failed',
  ]);
  const continuationGeneration = nonNegativeInteger(executorValue.continuationGeneration);
  const continuationCount = nonNegativeInteger(executorValue.continuationCount);
  if (
    !canonicalPosition ||
    !canonicalTaskName ||
    !taskPath ||
    !threadId ||
    !l1State ||
    !lastActivityAt ||
    !outcome ||
    continuationGeneration === null ||
    continuationCount === null
  )
    return undefined;
  const executorBlockingValue = record(executorValue.blocking);
  const executorBlocking = executorBlockingValue
    ? parseStructuredBlock(executorBlockingValue)
    : undefined;
  if (executorBlockingValue && !executorBlocking) return undefined;
  return {
    executor: {
      canonicalPosition,
      canonicalTaskName,
      taskPath,
      threadId,
      l1State,
      ...(l2State ? { l2State } : {}),
      lastActivityAt,
      ownedProcesses,
      outcome,
      ...(executorBlocking ? { blocking: executorBlocking } : {}),
      continuationGeneration,
      continuationCount,
    },
    ...(blocking ? { blocking } : {}),
    ...(supervision ? { supervision } : {}),
    ...(checkpoints ? { checkpoints } : {}),
  };
}

function parseCheckpoints(
  value: Record<string, unknown>,
): PersistedSupervisedLifecycle['checkpoints'] | undefined {
  const planIdentity = boundedText(value.planIdentity);
  if (value.protocolVersion !== 1 || !planIdentity) return undefined;
  if (!Array.isArray(value.reportedL1Ids) || value.reportedL1Ids.length > 128) return undefined;
  const reportedL1Ids = value.reportedL1Ids
    .map((id) => boundedText(id))
    .filter(Boolean) as string[];
  if (
    reportedL1Ids.length !== value.reportedL1Ids.length ||
    new Set(reportedL1Ids).size !== reportedL1Ids.length
  )
    return undefined;
  if (!Array.isArray(value.acceptedKeys) || value.acceptedKeys.length > 128) return undefined;
  const acceptedKeys = value.acceptedKeys
    .map((key) => boundedText(key))
    .filter(Boolean) as string[];
  if (
    acceptedKeys.length !== value.acceptedKeys.length ||
    new Set(acceptedKeys).size !== acceptedKeys.length
  )
    return undefined;
  const pendingTurnId = value.pendingTurnId === null ? null : boundedText(value.pendingTurnId);
  if (pendingTurnId === undefined) return undefined;
  if (typeof value.terminalReviewAccepted !== 'boolean') return undefined;
  return {
    protocolVersion: 1,
    planIdentity,
    reportedL1Ids,
    acceptedKeys,
    pendingTurnId,
    terminalReviewAccepted: value.terminalReviewAccepted,
  };
}

export function classifyExecutorOutcome(
  input: Readonly<{
    objectiveComplete: boolean;
    reportedOutcome?: ExecutorOutcome;
    blockingReason?: BlockingReason;
    resumeCondition?: ResumeCondition;
    /** Examined transiently for compatibility; never retained by the lifecycle record. */
    finalText?: string;
  }>,
): Readonly<{ outcome: ExecutorOutcome; blocking?: StructuredBlock }> {
  if (input.objectiveComplete) return { outcome: 'objective_complete' };
  if (input.reportedOutcome === 'cancelled' || input.reportedOutcome === 'failed')
    return { outcome: input.reportedOutcome };
  const blocking =
    input.blockingReason && input.resumeCondition
      ? { reason: input.blockingReason, resumeCondition: input.resumeCondition }
      : undefined;
  if (input.reportedOutcome === 'blocked' && validStructuredBlock(blocking))
    return { outcome: 'blocked', blocking };
  // A turn ending, a checkpoint, or free-form language about time/context is
  // not objective state. Incomplete Org state remains mechanically partial.
  return { outcome: 'partial' };
}

export function decideSupervisedLifecycle(
  input: SupervisedLifecycleInput,
): SupervisedLifecycleDecision {
  if (input.explicitlyPausedOrCancelled || executionComplete(input.plan))
    return { finalAllowed: true, action: { kind: 'allowFinal' } };
  if (validStructuredBlock(input.attention))
    return {
      finalAllowed: true,
      action: { kind: 'invokeAttention', ...input.attention },
    };

  const processes = input.executor?.ownedProcesses ?? [];
  const overBudget = processes.find(
    (process) =>
      (process.state === 'running' || process.state === 'detached-active') &&
      (process.elapsedMs > input.policy.processMaxElapsedMs ||
        (process.rssBytes !== null && process.rssBytes > input.policy.processMaxRssBytes)),
  );
  if (overBudget)
    return {
      finalAllowed: false,
      action: {
        kind: 'terminateProcess',
        threadId: overBudget.ownerThreadId,
        processId: overBudget.processId,
      },
    };

  const exited = processes.find(
    (process) => process.state === 'exited-awaiting-result' && process.resultArtifact,
  );
  if (exited)
    return {
      finalAllowed: false,
      action: {
        kind: 'consumeProcessResult',
        threadId: exited.ownerThreadId,
        processId: exited.processId,
        resultArtifact: exited.resultArtifact!,
      },
    };

  const active = processes.find(
    (process) => process.state === 'running' || process.state === 'detached-active',
  );
  if (active)
    return {
      finalAllowed: false,
      action: {
        kind: 'monitorProcess',
        process: { ...active, ownership: 'supervisor', state: 'detached-active' },
        pollAfterMs: input.policy.processPollMs,
      },
    };

  if (input.event === 'waitTimeout' && !input.executor)
    return { finalAllowed: false, action: { kind: 'reinspect' } };
  if (!input.executor || input.executor.l1State === 'DONE')
    return { finalAllowed: false, action: { kind: 'continueSupervisor' } };

  const exponent = Math.min(30, Math.max(0, input.executor.continuationCount));
  const delayMs = Math.min(
    input.policy.continuationMaxDelayMs,
    input.policy.continuationBaseDelayMs * 2 ** exponent,
  );
  return {
    finalAllowed: false,
    action: {
      kind: 'resumeExecutor',
      threadId: input.executor.threadId,
      generation: input.executor.continuationGeneration + 1,
      delayMs,
    },
  };
}

export function executorIdentity(canonicalTaskName: string, generation: number): ExecutorIdentity {
  if (
    !/^l[1-9]\d*(?:_[1-9]\d*)?$/.test(canonicalTaskName) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new Error('INVALID_EXECUTOR_IDENTITY');
  return {
    canonicalTaskName,
    canonicalPosition: orgPlanAgentDisplayName(canonicalTaskName),
    generation,
    taskName: generation === 1 ? canonicalTaskName : `${canonicalTaskName}_g${generation}`,
  };
}

function executionComplete(plan: SupervisedPlan): boolean {
  return (
    plan.executionComplete ??
    plan.steps.every(
      (step) =>
        step.state === 'DONE' &&
        step.reviewStatus === 'REVIEWED' &&
        step.children.every((child) => child.state === 'DONE'),
    )
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseStructuredBlock(value: Record<string, unknown>): StructuredBlock | undefined {
  const reason = stringValue(
    value.reason,
    Object.keys(blockingResumeConditions) as BlockingReason[],
  );
  const resumeCondition = stringValue(
    value.resumeCondition,
    Object.values(blockingResumeConditions),
  );
  const blocking = reason && resumeCondition ? { reason, resumeCondition } : undefined;
  return validStructuredBlock(blocking) ? blocking : undefined;
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function stringValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableNonNegativeNumber(value: unknown): number | null | undefined {
  return value === null ? null : (nonNegativeNumber(value) ?? undefined);
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
