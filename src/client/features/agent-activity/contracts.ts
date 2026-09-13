/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type AgentActivityState =
  'working' | 'idle' | 'awaitingAgent' | 'awaitingHuman' | 'blocked' | 'disconnected';
export type AgentActivityConfidence = 'fresh' | 'stale' | 'reconciling';
export type AgentActivitySnapshot = Readonly<{
  sessionId: string;
  root: { state: AgentActivityState; reason?: string; observedAt: string; lastActivityAt: string };
  subagents: readonly {
    id: string;
    nickname?: string;
    role?: string;
    model?: string;
    canonicalTaskName?: string;
    canonicalPosition?: string;
    continuationGeneration?: number;
    outcome?: 'partial' | 'cancelled' | 'failed';
    ownedProcesses?: readonly {
      state:
        | 'running'
        | 'detached-active'
        | 'exited-awaiting-result'
        | 'result-consumed'
        | 'terminated-for-budget';
      ownership: 'executor' | 'supervisor';
      observedAt: string;
    }[];
    state: AgentActivityState;
    reason?: string;
    observedAt: string;
    lastActivityAt: string;
  }[];
  aggregateSubagents: AgentActivityState;
  confidence: AgentActivityConfidence;
}>;

export function isAgentActivitySnapshot(
  value: unknown,
  sessionId?: string,
): value is AgentActivitySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  const states = new Set<AgentActivityState>([
    'working',
    'idle',
    'awaitingAgent',
    'awaitingHuman',
    'blocked',
    'disconnected',
  ]);
  const validText = (entry: unknown, limit = 256) =>
    typeof entry === 'string' && entry.length <= limit;
  const validProcesses = (entry: unknown): boolean =>
    Array.isArray(entry) &&
    entry.length <= 64 &&
    entry.every((process: unknown) => {
      const value = process as Record<string, unknown>;
      return (
        value &&
        typeof value === 'object' &&
        [
          'running',
          'detached-active',
          'exited-awaiting-result',
          'result-consumed',
          'terminated-for-budget',
        ].includes(value.state as string) &&
        ['executor', 'supervisor'].includes(value.ownership as string) &&
        validText(value.observedAt, 64) &&
        !Number.isNaN(Date.parse(value.observedAt as string))
      );
    });
  const validActor = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const actor = entry as Record<string, unknown>;
    return (
      validText(actor.state, 32) &&
      states.has(actor.state as AgentActivityState) &&
      validText(actor.observedAt, 64) &&
      validText(actor.lastActivityAt, 64) &&
      !Number.isNaN(Date.parse(actor.observedAt as string)) &&
      !Number.isNaN(Date.parse(actor.lastActivityAt as string)) &&
      (actor.reason === undefined || validText(actor.reason, 64))
    );
  };
  return (
    validText(snapshot.sessionId) &&
    (!sessionId || snapshot.sessionId === sessionId) &&
    validActor(snapshot.root) &&
    Array.isArray(snapshot.subagents) &&
    snapshot.subagents.length <= 64 &&
    snapshot.subagents.every(
      (child) =>
        validActor(child) &&
        validText((child as Record<string, unknown>).id) &&
        (typeof (child as Record<string, unknown>).nickname === 'undefined' ||
          validText((child as Record<string, unknown>).nickname)) &&
        (typeof (child as Record<string, unknown>).role === 'undefined' ||
          validText((child as Record<string, unknown>).role)) &&
        (typeof (child as Record<string, unknown>).model === 'undefined' ||
          validText((child as Record<string, unknown>).model)) &&
        (typeof (child as Record<string, unknown>).canonicalTaskName === 'undefined' ||
          validText((child as Record<string, unknown>).canonicalTaskName)) &&
        (typeof (child as Record<string, unknown>).canonicalPosition === 'undefined' ||
          validText((child as Record<string, unknown>).canonicalPosition, 32)) &&
        (typeof (child as Record<string, unknown>).continuationGeneration === 'undefined' ||
          (Number.isInteger((child as Record<string, unknown>).continuationGeneration) &&
            ((child as Record<string, unknown>).continuationGeneration as number) > 0)) &&
        (typeof (child as Record<string, unknown>).outcome === 'undefined' ||
          ['partial', 'cancelled', 'failed'].includes(
            (child as Record<string, unknown>).outcome as string,
          )) &&
        (typeof (child as Record<string, unknown>).ownedProcesses === 'undefined' ||
          validProcesses((child as Record<string, unknown>).ownedProcesses)),
    ) &&
    validText(snapshot.aggregateSubagents, 32) &&
    states.has(snapshot.aggregateSubagents as AgentActivityState) &&
    (snapshot.confidence === 'fresh' ||
      snapshot.confidence === 'stale' ||
      snapshot.confidence === 'reconciling')
  );
}
