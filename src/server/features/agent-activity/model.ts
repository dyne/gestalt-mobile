/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type AgentActivityState =
  'working' | 'idle' | 'awaitingAgent' | 'awaitingHuman' | 'blocked' | 'disconnected';
export type AgentActivityConfidence = 'fresh' | 'stale' | 'reconciling';
export type AgentActivityReason =
  | 'turnActive'
  | 'turnCompleted'
  | 'pendingInteraction'
  | 'planChange'
  | 'hardBlock'
  | 'missingDependency'
  | 'permissionRequired'
  | 'externalState'
  | 'materialAmbiguity'
  | 'collaborationWait'
  | 'agentError'
  | 'processExited'
  | 'missingCollaborationMetadata'
  | 'unknown';

export type RootAgentActivity = Readonly<{
  state: AgentActivityState;
  reason: AgentActivityReason;
  observedAt: string;
  lastActivityAt: string;
}>;
export type SubagentActivity = Readonly<{
  id: string;
  threadId?: string;
  nickname?: string;
  role?: string;
  state: AgentActivityState;
  reason: AgentActivityReason;
  observedAt: string;
  lastActivityAt: string;
}>;
export type AgentActivitySnapshot = Readonly<{
  sessionId: string;
  rootThreadId?: string;
  root: RootAgentActivity;
  subagents: readonly SubagentActivity[];
  aggregateSubagents: AgentActivityState;
  confidence: AgentActivityConfidence;
}>;

/** Narrow, transport-neutral facts. Duplicates and older facts are intentionally harmless. */
export type AgentActivityFact = Readonly<{
  sessionId: string;
  occurredAt: string;
  kind:
    | 'threadStarted'
    | 'threadStatus'
    | 'turnStarted'
    | 'turnCompleted'
    | 'interactionPending'
    | 'interactionResolved'
    | 'collaboration'
    | 'processExited'
    | 'observed';
  threadId?: string;
  turnId?: string;
  status?: string;
  childId?: string;
  childThreadId?: string;
  childNickname?: string;
  childRole?: string;
  childStatus?: string;
  collaborationAction?: string;
  attentionReason?: Extract<
    AgentActivityReason,
    | 'planChange'
    | 'hardBlock'
    | 'missingDependency'
    | 'permissionRequired'
    | 'externalState'
    | 'materialAmbiguity'
  >;
  hasPendingInteraction?: boolean;
}>;

const states: readonly AgentActivityState[] = [
  'blocked',
  'awaitingHuman',
  'working',
  'awaitingAgent',
  'idle',
  'disconnected',
];

export function createAgentActivitySnapshot(
  sessionId: string,
  observedAt: string,
): AgentActivitySnapshot {
  return Object.freeze({
    sessionId,
    root: Object.freeze({
      state: 'disconnected',
      reason: 'unknown',
      observedAt,
      lastActivityAt: observedAt,
    }),
    subagents: Object.freeze([]),
    aggregateSubagents: 'idle',
    confidence: 'stale',
  });
}

/** Pure reducer: authoritative facts win; an observed heartbeat never makes an active actor idle. */
export function projectAgentActivity(
  current: AgentActivitySnapshot,
  fact: AgentActivityFact,
): AgentActivitySnapshot {
  if (fact.sessionId !== current.sessionId || !validTimestamp(fact.occurredAt)) return current;
  // Notifications can replay or arrive out of order. Never let an older fact
  // regress an actor's authoritative state.
  if (Date.parse(fact.occurredAt) < Date.parse(current.root.observedAt)) return current;
  // A shared app-server stream includes spawned threads. Only a known root
  // thread may change root state; child-thread facts are mapped to that child.
  if (fact.threadId && current.rootThreadId && fact.threadId !== current.rootThreadId) {
    const child = current.subagents.find((candidate) => candidate.threadId === fact.threadId);
    if (!child) return current;
    const childFact = { ...fact };
    delete childFact.threadId;
    return projectAgentActivity(current, {
      ...childFact,
      childId: child.id,
      kind: 'collaboration',
      childStatus: fact.status,
    });
  }
  const observedAt = later(current.root.observedAt, fact.occurredAt);
  const root = {
    ...current.root,
    observedAt,
    lastActivityAt: later(current.root.lastActivityAt, fact.occurredAt),
  };
  const children = new Map(current.subagents.map((child) => [child.id, child]));
  if (fact.kind === 'turnStarted') Object.assign(root, { state: 'working', reason: 'turnActive' });
  if (fact.kind === 'threadStarted') applyStatus(root, fact.status);
  if (fact.kind === 'turnCompleted' && root.state !== 'awaitingHuman')
    Object.assign(root, { state: 'idle', reason: 'turnCompleted' });
  if (fact.kind === 'interactionPending')
    Object.assign(root, {
      state: 'awaitingHuman',
      reason: fact.attentionReason ?? 'pendingInteraction',
    });
  if (fact.kind === 'interactionResolved' && root.state === 'awaitingHuman')
    Object.assign(
      root,
      fact.hasPendingInteraction
        ? { state: 'awaitingHuman', reason: fact.attentionReason ?? 'pendingInteraction' }
        : { state: 'working', reason: 'turnActive' },
    );
  if (fact.kind === 'processExited')
    Object.assign(root, { state: 'disconnected', reason: 'processExited' });
  if (fact.kind === 'threadStatus') applyStatus(root, fact.status);
  if (fact.kind === 'collaboration') {
    // Older servers may omit experimental child metadata. That is a capability
    // downgrade, not evidence that the root process disappeared.
    if (!fact.childId) root.reason = 'missingCollaborationMetadata';
    else {
      const before = children.get(fact.childId);
      const child: SubagentActivity = Object.freeze({
        id: fact.childId,
        ...(fact.childThreadId
          ? { threadId: fact.childThreadId }
          : before?.threadId
            ? { threadId: before.threadId }
            : {}),
        ...(fact.childNickname
          ? { nickname: fact.childNickname }
          : before?.nickname
            ? { nickname: before.nickname }
            : {}),
        ...(fact.childRole ? { role: fact.childRole } : before?.role ? { role: before.role } : {}),
        state: childState(fact.childStatus, fact.collaborationAction, before?.state),
        reason: childReason(fact.childStatus, fact.collaborationAction),
        observedAt: fact.occurredAt,
        lastActivityAt: later(before?.lastActivityAt ?? fact.occurredAt, fact.occurredAt),
      });
      children.set(fact.childId, child);
      if (fact.collaborationAction === 'wait' && root.state === 'working')
        Object.assign(root, { state: 'awaitingAgent', reason: 'collaborationWait' });
    }
  }
  const subagents = Object.freeze([...children.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const next: AgentActivitySnapshot = Object.freeze({
    sessionId: current.sessionId,
    ...(current.rootThreadId || (fact.kind === 'threadStarted' && fact.threadId)
      ? { rootThreadId: current.rootThreadId ?? fact.threadId }
      : {}),
    root: Object.freeze(root),
    subagents,
    aggregateSubagents: aggregate(subagents),
    confidence: current.confidence,
  });
  return same(current, next) ? current : next;
}

export function withActivityConfidence(
  snapshot: AgentActivitySnapshot,
  confidence: AgentActivityConfidence,
): AgentActivitySnapshot {
  return snapshot.confidence === confidence ? snapshot : Object.freeze({ ...snapshot, confidence });
}

/** Process loss revokes child identities; recovery must repopulate them from a fresh list read. */
export function clearAgentActivityChildren(snapshot: AgentActivitySnapshot): AgentActivitySnapshot {
  if (snapshot.subagents.length === 0 && snapshot.aggregateSubagents === 'idle') return snapshot;
  return Object.freeze({
    ...snapshot,
    subagents: Object.freeze([]),
    aggregateSubagents: 'idle' as const,
  });
}

function applyStatus(
  root: { state: AgentActivityState; reason: AgentActivityReason },
  status?: string,
): void {
  if (status === 'error' || status === 'systemError' || status === 'failed')
    Object.assign(root, { state: 'blocked', reason: 'agentError' });
  else if (status === 'notLoaded')
    Object.assign(root, { state: 'disconnected', reason: 'processExited' });
  else if (status === 'idle' || status === 'completed')
    Object.assign(root, { state: 'idle', reason: 'turnCompleted' });
  else if (status === 'active' || status === 'working')
    Object.assign(root, { state: 'working', reason: 'turnActive' });
}
function childState(
  status?: string,
  action?: string,
  previous: AgentActivityState = 'working',
): AgentActivityState {
  if (status === 'error' || status === 'failed' || status === 'systemError') return 'blocked';
  if (status === 'completed' || status === 'idle' || action === 'close_agent') return 'idle';
  // `wait` belongs to the caller/root; it does not rewrite the child which may
  // still be working.  A child can explicitly report its own waiting status.
  if (status === 'disconnected' || status === 'notLoaded') return 'disconnected';
  return previous === 'idle' && action === 'resume_agent'
    ? 'working'
    : status === 'working' || status === 'active'
      ? 'working'
      : previous;
}
function childReason(status?: string, action?: string): AgentActivityReason {
  if (status === 'error' || status === 'failed' || status === 'systemError') return 'agentError';
  if (status === 'disconnected' || status === 'notLoaded') return 'processExited';
  if (action === 'wait') return 'collaborationWait';
  if (status === 'completed' || status === 'idle' || action === 'close_agent')
    return 'turnCompleted';
  return 'turnActive';
}
function aggregate(children: readonly SubagentActivity[]): AgentActivityState {
  return states.find((state) => children.some((child) => child.state === state)) ?? 'idle';
}
function validTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
function later(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}
function same(left: AgentActivitySnapshot, right: AgentActivitySnapshot): boolean {
  return JSON.stringify(semantic(left)) === JSON.stringify(semantic(right));
}
function semantic(snapshot: AgentActivitySnapshot): unknown {
  return {
    sessionId: snapshot.sessionId,
    rootThreadId: snapshot.rootThreadId,
    confidence: snapshot.confidence,
    root: { state: snapshot.root.state, reason: snapshot.root.reason },
    subagents: snapshot.subagents.map((child) => ({
      id: child.id,
      threadId: child.threadId,
      nickname: child.nickname,
      role: child.role,
      state: child.state,
      reason: child.reason,
    })),
    aggregateSubagents: snapshot.aggregateSubagents,
  };
}
