/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type AutopilotState =
  'disabled' | 'monitoring' | 'backoff' | 'attentionRequired' | 'completed' | 'safetyPaused';

export type AutopilotSnapshot = Readonly<{
  state: AutopilotState;
  enabled: boolean;
  health?: Readonly<{
    healthy: boolean;
    phase:
      | 'off'
      | 'rootWorking'
      | 'continuationScheduled'
      | 'waitingForAgentEvent'
      | 'checkingState'
      | 'needsYou'
      | 'safetyPaused'
      | 'complete'
      | 'degraded';
    supervision:
      | 'active'
      | 'probeRequired'
      | 'parked'
      | 'retrying'
      | 'attentionRequired'
      | 'safetyPaused'
      | 'none';
    wait: Readonly<{
      present: boolean;
      wakeCategories: readonly (
        | 'planChanged'
        | 'reviewChanged'
        | 'checkpointChanged'
        | 'interactionChanged'
        | 'executorChanged'
        | 'processExited'
        | 'processResultAvailable'
        | 'processLimitBreached'
        | 'agentActivityChanged'
      )[];
    }>;
    observedAt: string;
    lastTransitionAt: string;
    nextExpectedAction: string;
    degradationReason?:
      | 'missingContinuation'
      | 'invalidWaitLease'
      | 'controllerUnavailable'
      | 'staleTransition'
      | 'planMismatch';
  }>;
  reason?: string;
  retry: Readonly<{ position: number; limit: number }>;
  lastAutomaticAction?: Readonly<{ controlId: string; summary: string }>;
  nextEvaluationAt?: string;
  updatedAt: string;
}>;

export type OrgPlanAttention = Readonly<{
  requestId: string;
  turnId: string | null;
  requestedAt: string | null;
  attention: Readonly<{
    reason: string;
    summary: string;
    requestedAction: string;
    resumeCondition: string;
  }>;
}>;

/**
 * The relay's pending-interaction and journal event shape. Keep this separate
 * from the tool payload: `kind` belongs to the envelope, while the four safe
 * attention fields belong to `payload`.
 */
export type OrgPlanAttentionEnvelope = Readonly<{
  requestId: string;
  kind: 'orgPlanAttention';
  turnId: string | null;
  requestedAt: string | null;
  payload: OrgPlanAttention['attention'];
}>;

const text = (value: unknown, maximum = 600): value is string =>
  typeof value === 'string' && value.length <= maximum;
const timestamp = (value: unknown): value is string =>
  text(value, 64) && !Number.isNaN(Date.parse(value));

export function isAutopilotSnapshot(value: unknown): value is AutopilotSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.enabled === 'boolean' &&
    typeof snapshot.state === 'string' &&
    [
      'disabled',
      'monitoring',
      'backoff',
      'attentionRequired',
      'completed',
      'safetyPaused',
    ].includes(snapshot.state) &&
    Boolean(snapshot.retry) &&
    typeof snapshot.retry === 'object' &&
    Number.isInteger((snapshot.retry as Record<string, unknown>).position) &&
    Number.isInteger((snapshot.retry as Record<string, unknown>).limit) &&
    text(snapshot.updatedAt, 64) &&
    (snapshot.reason === undefined || text(snapshot.reason, 80)) &&
    (snapshot.nextEvaluationAt === undefined || text(snapshot.nextEvaluationAt, 64)) &&
    (snapshot.health === undefined || validHealth(snapshot.health))
  );
}

function validHealth(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const health = value as Record<string, unknown>;
  if (!health.wait || typeof health.wait !== 'object') return false;
  const wait = health.wait as Record<string, unknown>;
  return (
    typeof health.healthy === 'boolean' &&
    typeof health.phase === 'string' &&
    [
      'off',
      'rootWorking',
      'continuationScheduled',
      'waitingForAgentEvent',
      'checkingState',
      'needsYou',
      'safetyPaused',
      'complete',
      'degraded',
    ].includes(health.phase) &&
    [
      'active',
      'probeRequired',
      'parked',
      'retrying',
      'attentionRequired',
      'safetyPaused',
      'none',
    ].includes(health.supervision as string) &&
    typeof wait.present === 'boolean' &&
    Array.isArray(wait.wakeCategories) &&
    wait.wakeCategories.length <= 9 &&
    new Set(wait.wakeCategories).size === wait.wakeCategories.length &&
    wait.wakeCategories.every((item: unknown) =>
      [
        'planChanged',
        'reviewChanged',
        'checkpointChanged',
        'interactionChanged',
        'executorChanged',
        'processExited',
        'processResultAvailable',
        'processLimitBreached',
        'agentActivityChanged',
      ].includes(item as string),
    ) &&
    timestamp(health.observedAt) &&
    timestamp(health.lastTransitionAt) &&
    text(health.nextExpectedAction) &&
    (health.degradationReason === undefined ||
      [
        'missingContinuation',
        'invalidWaitLease',
        'controllerUnavailable',
        'staleTransition',
        'planMismatch',
      ].includes(health.degradationReason as string))
  );
}

export function isOrgPlanAttention(value: unknown): value is OrgPlanAttention {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const attention = item.attention;
  if (!attention || typeof attention !== 'object') return false;
  const fields = attention as Record<string, unknown>;
  return (
    text(item.requestId, 256) &&
    (item.turnId === null || text(item.turnId, 256)) &&
    (item.requestedAt === null || text(item.requestedAt, 64)) &&
    text(fields.reason, 64) &&
    text(fields.summary) &&
    text(fields.requestedAction) &&
    text(fields.resumeCondition, 64)
  );
}

export function isOrgPlanAttentionEnvelope(value: unknown): value is OrgPlanAttentionEnvelope {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === 'orgPlanAttention' &&
    isOrgPlanAttention({
      requestId: item.requestId,
      turnId: item.turnId ?? null,
      requestedAt: item.requestedAt ?? null,
      attention: item.payload,
    })
  );
}

export function toOrgPlanAttention(value: OrgPlanAttentionEnvelope): OrgPlanAttention {
  return {
    requestId: value.requestId,
    turnId: value.turnId,
    requestedAt: value.requestedAt,
    attention: value.payload,
  };
}
