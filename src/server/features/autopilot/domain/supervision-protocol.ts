/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Facts which may wake a parked supervisor without inspecting conversation text. */
export const observableWakeConditions = [
  'planChanged',
  'reviewChanged',
  'checkpointChanged',
  'interactionChanged',
  'executorChanged',
  'processExited',
  'processResultAvailable',
  'processLimitBreached',
  'agentActivityChanged',
] as const;

export type ObservableWakeCondition = (typeof observableWakeConditions)[number];

export type SemanticProgressFacts = Readonly<{
  plan: Readonly<{ identity: string; fingerprint: string; currentPosition: string | null }>;
  review: Readonly<{ status: 'UNREVIEWED' | 'REVIEWED' | null }>;
  checkpoint: Readonly<{ pendingTurnId: string | null; terminalReviewAccepted: boolean }>;
  pendingInteractions: readonly Readonly<{ id: string; kind: string; state: string }>[];
  executor: Readonly<{ generation: number; state: string | null }>;
  ownedProcesses: readonly Readonly<{ id: string; state: string; ownerGeneration: number }>[];
  /** Sequenced facts only: timestamps and agent prose are deliberately absent. */
  agentActivity: readonly Readonly<{ agentId: string; sequence: number; state: string }>[];
}>;

/**
 * A canonical, durable representation rather than a clock- or transcript-derived score.
 * The string is intentionally opaque to callers; compare it only for equality.
 */
export function semanticProgressKey(facts: SemanticProgressFacts): string {
  return JSON.stringify({
    plan: facts.plan,
    review: facts.review,
    checkpoint: facts.checkpoint,
    pendingInteractions: [...facts.pendingInteractions]
      .map(({ id, kind, state }) => ({ id, kind, state }))
      .sort(compareBy('id')),
    executor: facts.executor,
    ownedProcesses: [...facts.ownedProcesses]
      .map(({ id, state, ownerGeneration }) => ({ id, state, ownerGeneration }))
      .sort(compareBy('id')),
    agentActivity: latestAgentActivity(facts.agentActivity),
  });
}

function latestAgentActivity(
  observations: SemanticProgressFacts['agentActivity'],
): readonly Readonly<{ agentId: string; sequence: number; state: string }>[] {
  const latest = new Map<string, Readonly<{ agentId: string; sequence: number; state: string }>>();
  for (const observation of observations) {
    const current = latest.get(observation.agentId);
    if (
      !current ||
      observation.sequence > current.sequence ||
      (observation.sequence === current.sequence &&
        observation.state.localeCompare(current.state) < 0)
    )
      latest.set(observation.agentId, observation);
  }
  return [...latest.values()]
    .map(({ agentId, sequence, state }) => ({ agentId, sequence, state }))
    .sort(compareBy('agentId'));
}

function compareBy<Key extends string>(key: Key) {
  return <Value extends Record<Key, string>>(left: Value, right: Value) =>
    left[key].localeCompare(right[key]);
}

export type SupervisionProtocolState = Readonly<{
  outcome:
    'active' | 'probeRequired' | 'parked' | 'retrying' | 'attentionRequired' | 'safetyPaused';
  progressKey: string;
  unchangedContinuations: 0 | 1 | 2 | 3;
  probeKey: string | null;
  lastReportId: string | null;
  waitLease: Readonly<{
    id: string;
    probeKey: string;
    wakeConditions: readonly ObservableWakeCondition[];
  }> | null;
  retryKey: string | null;
  safetyPauseReason: 'retryRecurrence' | 'invalidProbeReport' | null;
}>;

export function startSupervisionProtocol(progressKey: string): SupervisionProtocolState {
  return {
    outcome: 'active',
    progressKey,
    unchangedContinuations: 0,
    probeKey: null,
    lastReportId: null,
    waitLease: null,
    retryKey: null,
    safetyPauseReason: null,
  };
}

/** Records an automatic continuation result; prose and timestamps are not inputs. */
export function recordAutomaticContinuation(
  state: SupervisionProtocolState,
  progressKey: string,
): SupervisionProtocolState {
  if (
    state.outcome === 'parked' ||
    state.outcome === 'attentionRequired' ||
    state.outcome === 'safetyPaused'
  )
    return state;
  if (state.outcome === 'retrying' && progressKey === state.retryKey)
    return { ...state, outcome: 'safetyPaused', safetyPauseReason: 'retryRecurrence' };
  if (progressKey !== state.progressKey)
    return { ...startSupervisionProtocol(progressKey), lastReportId: state.lastReportId };
  const unchangedContinuations = Math.min(3, state.unchangedContinuations + 1) as 0 | 1 | 2 | 3;
  if (unchangedContinuations === 3 && state.probeKey !== progressKey)
    return { ...state, unchangedContinuations, outcome: 'probeRequired', probeKey: progressKey };
  return { ...state, unchangedContinuations };
}

export type ProbeReport =
  | Readonly<{ id: string; kind: 'attention' }>
  | Readonly<{ id: string; kind: 'actionable' }>
  | Readonly<{
      id: string;
      kind: 'wait';
      leaseId: string;
      wakeConditions: readonly ObservableWakeCondition[];
    }>;

/** Accepts only structured, bounded probe reports. Unsupported waits fail closed. */
export function reportProbe(
  state: SupervisionProtocolState,
  report: ProbeReport,
): SupervisionProtocolState {
  if (state.lastReportId === report.id) return state;
  if (state.outcome !== 'probeRequired' || !state.probeKey) return state;
  if (report.kind === 'attention')
    return { ...state, outcome: 'attentionRequired', lastReportId: report.id };
  if (report.kind === 'actionable')
    return {
      ...startSupervisionProtocol(state.progressKey),
      lastReportId: report.id,
    };
  const wakeConditions = uniqueSupportedWakeConditions(report.wakeConditions);
  if (!report.leaseId || wakeConditions.length === 0) return state;
  return {
    ...state,
    outcome: 'parked',
    lastReportId: report.id,
    waitLease: { id: report.leaseId, probeKey: state.probeKey, wakeConditions },
  };
}

export type ObservableWake = Readonly<{
  leaseId: string;
  condition: ObservableWakeCondition;
  progressKey: string;
}>;

/** A wake is useful only when it matches the durable lease and changed semantic state. */
export function consumeObservableWake(
  state: SupervisionProtocolState,
  wake: ObservableWake,
): SupervisionProtocolState {
  const lease = state.waitLease;
  if (
    state.outcome !== 'parked' ||
    !lease ||
    wake.leaseId !== lease.id ||
    !lease.wakeConditions.includes(wake.condition) ||
    wake.progressKey === lease.probeKey
  )
    return state;
  return {
    ...state,
    outcome: 'retrying',
    progressKey: wake.progressKey,
    unchangedContinuations: 0,
    probeKey: null,
    waitLease: null,
    retryKey: wake.progressKey,
  };
}

/** Manual recovery is the only transition out of durable safety pause. */
export function recoverSafetyPause(
  state: SupervisionProtocolState,
  progressKey: string,
): SupervisionProtocolState {
  return state.outcome === 'safetyPaused' ? startSupervisionProtocol(progressKey) : state;
}

/** Reject malformed persisted values instead of silently resuming automatic work. */
export function parseSupervisionProtocolState(
  value: unknown,
): SupervisionProtocolState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const base = startSupervisionProtocol(
    typeof candidate.progressKey === 'string' ? candidate.progressKey : '',
  );
  if (!base.progressKey || !isProtocolOutcome(candidate.outcome)) return undefined;
  const unchangedContinuations = candidate.unchangedContinuations;
  if (
    unchangedContinuations !== 0 &&
    unchangedContinuations !== 1 &&
    unchangedContinuations !== 2 &&
    unchangedContinuations !== 3
  )
    return undefined;
  const probeKey = nullableText(candidate.probeKey);
  const lastReportId = nullableText(candidate.lastReportId);
  const retryKey = nullableText(candidate.retryKey);
  if (probeKey === undefined || lastReportId === undefined || retryKey === undefined)
    return undefined;
  const waitLease = parseWaitLease(candidate.waitLease);
  if (waitLease === undefined) return undefined;
  if (
    candidate.safetyPauseReason !== null &&
    candidate.safetyPauseReason !== 'retryRecurrence' &&
    candidate.safetyPauseReason !== 'invalidProbeReport'
  )
    return undefined;
  return {
    ...base,
    outcome: candidate.outcome,
    unchangedContinuations,
    probeKey,
    lastReportId,
    waitLease,
    retryKey,
    safetyPauseReason: candidate.safetyPauseReason,
  };
}

function uniqueSupportedWakeConditions(
  conditions: readonly ObservableWakeCondition[],
): readonly ObservableWakeCondition[] {
  return [...new Set(conditions)].filter((condition): condition is ObservableWakeCondition =>
    (observableWakeConditions as readonly string[]).includes(condition),
  );
}

function isProtocolOutcome(value: unknown): value is SupervisionProtocolState['outcome'] {
  return [
    'active',
    'probeRequired',
    'parked',
    'retrying',
    'attentionRequired',
    'safetyPaused',
  ].includes(value as string);
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseWaitLease(value: unknown): SupervisionProtocolState['waitLease'] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.probeKey !== 'string' ||
    !candidate.probeKey ||
    !Array.isArray(candidate.wakeConditions)
  )
    return undefined;
  const wakeConditions = uniqueSupportedWakeConditions(
    candidate.wakeConditions as ObservableWakeCondition[],
  );
  return wakeConditions.length === candidate.wakeConditions.length
    ? { id: candidate.id, probeKey: candidate.probeKey, wakeConditions }
    : undefined;
}
