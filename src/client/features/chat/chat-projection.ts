/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  ChatItem,
  ChatSnapshot,
  SafeInteractionOutcome,
  SafeInteractionSnapshot,
} from '../../../shared/contracts/chat-snapshot.js';
import { autopilotAuditLabel } from '../../../shared/contracts/autopilot-audit.js';
import { toActivity, type HistoryActivity } from './activity-summary.js';
import type { ChatMessage } from './message-store.js';

export type PromptState = 'submitting' | 'accepted' | 'failed' | 'canonical';
export type TurnLifecycle = 'starting' | 'working' | 'finished' | 'interrupted' | 'recoverable';
export type InteractionState = 'pending' | 'submitting' | 'resolved' | 'failed';

export type ProjectedPrompt = Readonly<{
  operationId: string;
  key: string;
  text: string;
  state: PromptState;
  turnId?: string | null;
  occurredAt?: number;
}>;
export type ProjectedInteraction = Readonly<{
  requestId: string;
  key: string;
  kind: string;
  turnId?: string | null;
  payload: unknown;
  state: InteractionState;
  operationId?: string;
  attemptedOutcome?: unknown;
  occurredAt?: number;
}>;
export type ChatProjection = Readonly<{
  sessionId: string | null;
  cursor: number;
  snapshotting: boolean;
  lifecycle: TurnLifecycle;
  activeTurnId: string | null;
  messages: readonly ChatMessage[];
  activities: readonly HistoryActivity[];
  prompts: readonly ProjectedPrompt[];
  interactions: readonly ProjectedInteraction[];
  /** The server intentionally retained only a bounded filtered audit tail. */
  autopilotAuditTruncated: boolean;
  buffered: ReadonlyMap<number, ProjectionEvent>;
}>;
export type ProjectionEvent = Readonly<{
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt?: string;
}>;

const empty = (): ChatProjection => ({
  sessionId: null,
  cursor: 0,
  snapshotting: false,
  lifecycle: 'finished',
  activeTurnId: null,
  messages: [],
  activities: [],
  prompts: [],
  interactions: [],
  autopilotAuditTruncated: false,
  buffered: new Map(),
});
export const createChatProjection = (sessionId: string | null = null): ChatProjection => ({
  ...empty(),
  sessionId,
});

function messageFromItem(item: ChatItem): ChatMessage | null {
  if (item.kind === 'autopilot')
    return {
      id: `item:${item.id}`,
      role: 'audit',
      text: 'Continued execution automatically',
      ...(typeof item.occurredAt === 'number' && Number.isFinite(item.occurredAt)
        ? { occurredAt: item.occurredAt }
        : {}),
      ...(typeof item.controlId === 'string' ? { controlId: item.controlId } : {}),
      complete: true,
    };
  if ((item.kind !== 'user' && item.kind !== 'agent') || typeof item.text !== 'string') return null;
  return {
    id: `item:${item.id}`,
    role: item.kind === 'user' ? 'user' : 'assistant',
    text: item.text,
    ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
    ...(typeof item.occurredAt === 'number' && Number.isFinite(item.occurredAt)
      ? { occurredAt: item.occurredAt }
      : {}),
    ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
    complete: true,
  };
}
function auditMessage(item: {
  id: string;
  label: string;
  occurredAt: number;
  controlId?: string;
}): ChatMessage {
  return {
    id: item.id,
    role: 'audit',
    text: item.label,
    occurredAt: item.occurredAt,
    ...(item.controlId ? { controlId: item.controlId } : {}),
    complete: true,
  };
}
function auditEventMessage(event: ProjectionEvent): ChatMessage | null {
  const occurredAt = parseOccurredAt(event.occurredAt);
  const label = autopilotAuditLabel(event.type, event.payload);
  const controlId =
    event.payload &&
    typeof event.payload === 'object' &&
    typeof (event.payload as { controlId?: unknown }).controlId === 'string'
      ? (event.payload as { controlId: string }).controlId
      : undefined;
  return label && occurredAt !== undefined
    ? auditMessage({
        id: `audit:${event.sequence}`,
        label,
        occurredAt,
        ...(controlId ? { controlId } : {}),
      })
    : null;
}
function parseOccurredAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
function interaction(snapshot: SafeInteractionSnapshot): ProjectedInteraction {
  const occurredAt = parseOccurredAt(snapshot.requestedAt);
  return {
    requestId: snapshot.requestId,
    key: `interaction:${snapshot.requestId}`,
    kind: snapshot.kind,
    turnId: snapshot.turnId,
    payload: 'payload' in snapshot ? snapshot.payload : null,
    state: snapshot.resolvedAt
      ? snapshot.outcome === 'failed'
        ? 'failed'
        : 'resolved'
      : 'pending',
    ...(snapshot.resolvedAt ? { attemptedOutcome: snapshot.outcome } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}
function safeOutcome(
  interaction: ProjectedInteraction | undefined,
  attemptedOutcome: unknown,
): SafeInteractionOutcome | undefined {
  if (
    attemptedOutcome === 'approved' ||
    attemptedOutcome === 'denied' ||
    attemptedOutcome === 'answered' ||
    attemptedOutcome === 'dismissed' ||
    attemptedOutcome === 'failed'
  )
    return attemptedOutcome;
  if (interaction?.kind === 'quiz' || interaction?.kind === 'userInput') return 'answered';
  if (
    typeof attemptedOutcome === 'object' &&
    attemptedOutcome !== null &&
    (attemptedOutcome as { decision?: unknown }).decision === 'decline'
  )
    return 'denied';
  return interaction ? 'approved' : undefined;
}
function lifecycle(activeTurnId: string | null, previous: TurnLifecycle): TurnLifecycle {
  if (activeTurnId)
    return previous === 'finished' || previous === 'interrupted' ? previous : 'working';
  return previous === 'working' || previous === 'starting' || previous === 'recoverable'
    ? 'finished'
    : previous;
}
function unique<T extends { key?: string; id?: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.key ?? item.id ?? '', item])).values()];
}
function upsertActivity(
  activities: readonly HistoryActivity[],
  activity: HistoryActivity,
): HistoryActivity[] {
  return activities.some((item) => item.id === activity.id)
    ? activities.map((item) =>
        item.id === activity.id
          ? {
              ...activity,
              ...(activity.occurredAt === undefined && item.occurredAt !== undefined
                ? { occurredAt: item.occurredAt }
                : {}),
            }
          : item,
      )
    : [...activities, activity];
}
function mergeMessages(
  items: readonly ChatItem[],
  prompts: readonly ProjectedPrompt[],
  previous: readonly ChatMessage[],
): ChatMessage[] {
  const old = new Map(previous.map((message) => [message.id, message]));
  const previousIndex = new Map(previous.map((message, index) => [message.id, index]));
  const unmatched = new Set(
    prompts.filter((prompt) => prompt.state !== 'canonical').map((prompt) => prompt.operationId),
  );
  const retained = new Set<string>();
  const canonical = items.flatMap((item) => {
    const message = messageFromItem(item);
    if (!message) return [];
    if (item.kind === 'user') {
      const direct = prompts.find(
        (prompt) =>
          (typeof item.operationId === 'string' && item.operationId === prompt.operationId) ||
          (typeof item.turnId === 'string' && item.turnId === prompt.turnId),
      );
      const fallback =
        !direct &&
        prompts.filter((prompt) => prompt.state !== 'canonical' && prompt.text === item.text)
          .length === 1
          ? prompts.find((prompt) => prompt.state !== 'canonical' && prompt.text === item.text)
          : undefined;
      const prompt = direct ?? fallback;
      if (prompt) {
        unmatched.delete(prompt.operationId);
        const existing = old.get(prompt.key);
        const reconciled = {
          ...message,
          id: prompt.key,
          turnId: prompt.turnId ?? message.turnId,
          ...(message.occurredAt === undefined && existing?.occurredAt !== undefined
            ? { occurredAt: existing.occurredAt }
            : {}),
        };
        retained.add(reconciled.id);
        return [
          existing &&
          existing.text === reconciled.text &&
          existing.turnId === reconciled.turnId &&
          existing.complete === reconciled.complete &&
          existing.occurredAt === reconciled.occurredAt
            ? existing
            : reconciled,
        ];
      }
    }
    if (item.kind === 'agent' && typeof item.turnId === 'string') {
      const live =
        old.get(`assistant:${item.id}`) ??
        previous.find((candidate) =>
          Boolean(
            candidate.role === 'assistant' &&
            candidate.turnId === item.turnId &&
            candidate.text === message.text &&
            (candidate.phase === message.phase || !candidate.complete),
          ),
        );
      if (live) {
        retained.add(live.id);
        const reconciled = {
          ...message,
          id: live.id,
          turnId: message.turnId ?? live.turnId,
          ...(message.occurredAt === undefined && live.occurredAt !== undefined
            ? { occurredAt: live.occurredAt }
            : {}),
        };
        return [
          live.text === reconciled.text &&
          live.phase === reconciled.phase &&
          live.occurredAt === reconciled.occurredAt
            ? live
            : reconciled,
        ];
      }
    }
    retained.add(message.id);
    return [message];
  });
  const optimistic = prompts
    .filter((prompt) => unmatched.has(prompt.operationId))
    .map(
      (prompt) =>
        old.get(prompt.key) ?? {
          id: prompt.key,
          role: 'user' as const,
          text: prompt.text,
          complete: prompt.state === 'failed',
          ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
        },
    );
  const live = previous.filter(
    (message) =>
      message.role === 'assistant' &&
      message.id.startsWith('assistant:') &&
      !retained.has(message.id),
  );
  const extras = unique([...optimistic, ...live]);
  const canonicalIndex = new Map(canonical.map((message, index) => [message.id, index]));
  const slots = new Map<number, ChatMessage[]>();

  for (const message of extras) {
    let after: number | null = null;
    if (message.turnId) {
      for (let index = canonical.length - 1; index >= 0; index -= 1) {
        if (canonical[index]?.turnId === message.turnId) {
          after = index;
          break;
        }
      }
    }
    if (after === null) {
      const index = previousIndex.get(message.id);
      if (index !== undefined) {
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const anchor = canonicalIndex.get(previous[cursor]!.id);
          if (anchor !== undefined) {
            after = anchor;
            break;
          }
        }
        if (after === null) {
          for (let cursor = index + 1; cursor < previous.length; cursor += 1) {
            const anchor = canonicalIndex.get(previous[cursor]!.id);
            if (anchor !== undefined) {
              after = anchor - 1;
              break;
            }
          }
        }
      }
    }
    const slot = after ?? canonical.length - 1;
    slots.set(slot, [...(slots.get(slot) ?? []), message]);
  }

  return unique([
    ...(slots.get(-1) ?? []),
    ...canonical.flatMap((message, index) => [message, ...(slots.get(index) ?? [])]),
  ]);
}

/** Cache input is deliberately treated as untrusted: it is only a local rendering hint. */
export function hydrateCache(sessionId: string, cached: unknown): ChatProjection {
  if (!cached || typeof cached !== 'object') return createChatProjection(sessionId);
  const candidate = cached as Partial<ChatProjection>;
  if (
    !Number.isInteger(candidate.cursor) ||
    candidate.cursor! < 0 ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.prompts) ||
    !Array.isArray(candidate.interactions)
  )
    return createChatProjection(sessionId);
  const promptStates: PromptState[] = ['submitting', 'accepted', 'failed', 'canonical'];
  const interactionStates: InteractionState[] = ['pending', 'submitting', 'resolved', 'failed'];
  const lifecycles: TurnLifecycle[] = [
    'starting',
    'working',
    'finished',
    'interrupted',
    'recoverable',
  ];
  return {
    ...createChatProjection(sessionId),
    sessionId,
    cursor: candidate.cursor!,
    lifecycle: lifecycles.includes(candidate.lifecycle as TurnLifecycle)
      ? (candidate.lifecycle as TurnLifecycle)
      : 'finished',
    activeTurnId:
      typeof candidate.activeTurnId === 'string' || candidate.activeTurnId === null
        ? candidate.activeTurnId
        : null,
    snapshotting: false,
    buffered: new Map(),
    messages: candidate.messages
      .filter((message): message is ChatMessage =>
        Boolean(
          message &&
          typeof message.id === 'string' &&
          (message.role === 'user' || message.role === 'assistant' || message.role === 'audit') &&
          typeof message.text === 'string' &&
          (message.occurredAt === undefined ||
            (typeof message.occurredAt === 'number' && Number.isFinite(message.occurredAt))),
        ),
      )
      .slice(-200),
    activities: Array.isArray(candidate.activities)
      ? candidate.activities
          .filter((activity): activity is HistoryActivity =>
            Boolean(
              activity &&
              typeof activity.id === 'string' &&
              typeof activity.label === 'string' &&
              typeof activity.detail === 'string' &&
              (activity.turnId === undefined || typeof activity.turnId === 'string'),
            ),
          )
          .slice(-200)
      : [],
    prompts: candidate.prompts
      .filter((prompt): prompt is ProjectedPrompt =>
        Boolean(
          prompt &&
          typeof prompt.operationId === 'string' &&
          typeof prompt.key === 'string' &&
          typeof prompt.text === 'string' &&
          promptStates.includes(prompt.state) &&
          (prompt.occurredAt === undefined ||
            (typeof prompt.occurredAt === 'number' && Number.isFinite(prompt.occurredAt))),
        ),
      )
      .slice(-200),
    interactions: candidate.interactions
      .filter((item): item is ProjectedInteraction =>
        Boolean(
          item &&
          typeof item.requestId === 'string' &&
          typeof item.key === 'string' &&
          typeof item.kind === 'string' &&
          (item.turnId === undefined || item.turnId === null || typeof item.turnId === 'string') &&
          interactionStates.includes(item.state) &&
          (item.occurredAt === undefined ||
            (typeof item.occurredAt === 'number' && Number.isFinite(item.occurredAt))),
        ),
      )
      .slice(-200),
  };
}

/** Accepts authoritative history without discarding a still-pending local operation. */
export function acceptSnapshot(current: ChatProjection, snapshot: ChatSnapshot): ChatProjection {
  if (!Number.isInteger(snapshot.baseSequence) || snapshot.baseSequence < 0) return current;
  // The projection has already applied state newer than this snapshot cut. Rebuilding
  // from the stale snapshot would roll those sequenced events back, so retain the
  // current projection and only drain events buffered while the request was in flight.
  if (snapshot.baseSequence < current.cursor)
    return replayBuffered({ ...current, snapshotting: false });
  const canonicalUsers = snapshot.items.filter((item) => item.kind === 'user');
  const prompts = current.prompts.map((prompt) => {
    const correlated = canonicalUsers.some(
      (item) =>
        (typeof item.turnId === 'string' && item.turnId === prompt.turnId) ||
        (typeof item.operationId === 'string' && item.operationId === prompt.operationId),
    );
    const sameText = canonicalUsers.filter((item) => item.text === prompt.text);
    // Text is only a safe fallback when it identifies a single outstanding prompt and item.
    const unambiguousFallback =
      !prompt.turnId &&
      sameText.length === 1 &&
      current.prompts.filter((item) => item.state !== 'canonical' && item.text === prompt.text)
        .length === 1;
    return correlated || unambiguousFallback ? { ...prompt, state: 'canonical' as const } : prompt;
  });
  const canonicalInteractions = snapshot.interactions.map(interaction);
  const priorById = new Map(current.interactions.map((item) => [item.requestId, item]));
  const interactions = unique(
    canonicalInteractions.map((next) => {
      const prior = priorById.get(next.requestId);
      if (prior?.state === 'resolved') return prior;
      return {
        ...next,
        ...(next.occurredAt === undefined && prior?.occurredAt !== undefined
          ? { occurredAt: prior.occurredAt }
          : {}),
      };
    }),
  );
  const canonicalActivities = unique(
    snapshot.items
      .flatMap((item) => {
        const activity = toActivity(item);
        return activity ? [{ ...activity, key: `activity:${activity.id}` }] : [];
      })
      .concat(
        (snapshot.activities ?? []).map((activity) => ({
          ...activity,
          key: `activity:${activity.id}`,
        })),
      ) as Array<HistoryActivity & { key: string }>,
  ).map((item) => ({
    id: item.id,
    label: item.label,
    detail: item.detail,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.occurredAt !== undefined ? { occurredAt: item.occurredAt } : {}),
  }));
  const activities = canonicalActivities.reduce(upsertActivity, [...current.activities]);
  const turnTimes = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
  const items = snapshot.items.map((item) => {
    if (typeof item.occurredAt === 'number' && Number.isFinite(item.occurredAt)) return item;
    const turn = typeof item.turnId === 'string' ? turnTimes.get(item.turnId) : undefined;
    const occurredAt =
      item.kind === 'agent'
        ? (turn?.completedAt ?? turn?.startedAt)
        : (turn?.startedAt ?? turn?.completedAt);
    return typeof occurredAt === 'number' && Number.isFinite(occurredAt)
      ? { ...item, occurredAt }
      : item;
  });
  const auditItems = (snapshot.autopilotAudit ?? []).filter(
    (item): item is { id: string; label: string; occurredAt: number; controlId?: string } =>
      typeof item?.id === 'string' &&
      typeof item.label === 'string' &&
      typeof item.occurredAt === 'number' &&
      Number.isFinite(item.occurredAt),
  );
  const projected: ChatProjection = {
    ...current,
    cursor: Math.max(current.cursor, snapshot.baseSequence),
    snapshotting: false,
    activeTurnId: snapshot.activeTurnId,
    lifecycle: lifecycle(
      snapshot.activeTurnId,
      current.cursor === 0 && current.lifecycle === 'finished' ? 'working' : current.lifecycle,
    ),
    prompts,
    messages: unique(
      mergeMessages(items, prompts, current.messages).concat(auditItems.map(auditMessage)),
    ).sort(
      (left, right) =>
        (left.occurredAt ?? Number.MAX_SAFE_INTEGER) -
        (right.occurredAt ?? Number.MAX_SAFE_INTEGER),
    ),
    activities,
    interactions,
    autopilotAuditTruncated: snapshot.autopilotAuditTruncated === true,
    buffered: new Map(
      [...current.buffered].filter(([sequence]) => sequence > snapshot.baseSequence),
    ),
  };
  return replayBuffered({
    ...projected,
    messages: canonicalAutopilotAudit(projected.messages),
  });
}

/** History items and turn-started journal records describe the same coordinator action. */
function canonicalAutopilotAudit(messages: readonly ChatMessage[]): ChatMessage[] {
  const seenControls = new Set<string>();
  return messages.filter((message) => {
    if (message.role !== 'audit' || !message.controlId) return true;
    if (seenControls.has(message.controlId)) return false;
    seenControls.add(message.controlId);
    return true;
  });
}

export function beginSnapshot(current: ChatProjection): ChatProjection {
  return { ...current, snapshotting: true };
}
export function queuePrompt(
  current: ChatProjection,
  operationId: string,
  text: string,
  occurredAt?: number,
): ChatProjection {
  if (!text.trim() || current.prompts.some((prompt) => prompt.operationId === operationId))
    return current;
  const prompt: ProjectedPrompt = {
    operationId,
    key: `prompt:${operationId}`,
    text,
    state: 'submitting',
    turnId: null,
    ...(typeof occurredAt === 'number' && Number.isFinite(occurredAt) ? { occurredAt } : {}),
  };
  return {
    ...current,
    lifecycle: 'starting',
    prompts: [...current.prompts, prompt],
    messages: [
      ...current.messages,
      {
        id: prompt.key,
        role: 'user',
        text,
        ...(prompt.occurredAt !== undefined ? { occurredAt: prompt.occurredAt } : {}),
        complete: false,
      },
    ],
  };
}
export function queueActivePrompt(
  current: ChatProjection,
  operationId: string,
  text: string,
  occurredAt?: number,
): ChatProjection {
  const queued = queuePrompt(current, operationId, text, occurredAt);
  return queued === current ? current : { ...queued, lifecycle: 'working' };
}
export function promotePrompt(
  current: ChatProjection,
  operationId: string,
  turnId: string | null,
): ChatProjection {
  return {
    ...current,
    activeTurnId: turnId ?? current.activeTurnId,
    lifecycle: turnId ? 'working' : current.lifecycle,
    prompts: current.prompts.map((prompt) =>
      prompt.operationId === operationId ? { ...prompt, state: 'accepted', turnId } : prompt,
    ),
    messages: current.messages.map((message) =>
      message.id === `prompt:${operationId}`
        ? { ...message, complete: true, ...(turnId ? { turnId } : {}) }
        : message,
    ),
  };
}
export function failPrompt(current: ChatProjection, operationId: string): ChatProjection {
  return {
    ...current,
    lifecycle: 'recoverable',
    prompts: current.prompts.map((prompt) =>
      prompt.operationId === operationId ? { ...prompt, state: 'failed' } : prompt,
    ),
    messages: current.messages.map((message) =>
      message.id === `prompt:${operationId}` ? { ...message, complete: true } : message,
    ),
  };
}
export function beginInteraction(
  current: ChatProjection,
  requestId: string,
  operationId?: string,
): ChatProjection {
  return {
    ...current,
    interactions: current.interactions.map((item) =>
      item.requestId === requestId && (item.state === 'pending' || item.state === 'failed')
        ? { ...item, state: 'submitting', ...(operationId ? { operationId } : {}) }
        : item,
    ),
  };
}
export function failInteraction(
  current: ChatProjection,
  requestId: string,
  attemptedOutcome: unknown,
): ChatProjection {
  return {
    ...current,
    interactions: current.interactions.map((item) =>
      item.requestId === requestId && item.state !== 'resolved'
        ? { ...item, state: 'failed', attemptedOutcome }
        : item,
    ),
  };
}
export function resolveInteraction(
  current: ChatProjection,
  requestId: string,
  attemptedOutcome?: unknown,
): ChatProjection {
  return {
    ...current,
    interactions: current.interactions.map((item) =>
      item.requestId === requestId
        ? {
            ...item,
            state: 'resolved',
            ...(safeOutcome(item, attemptedOutcome)
              ? { attemptedOutcome: safeOutcome(item, attemptedOutcome) }
              : {}),
          }
        : item,
    ),
  };
}

export function applyProjectionEvent(
  current: ChatProjection,
  event: ProjectionEvent,
): ChatProjection {
  if (!Number.isInteger(event.sequence) || event.sequence <= current.cursor) return current;
  if (current.snapshotting || event.sequence > current.cursor + 1) {
    const buffered = new Map(current.buffered);
    buffered.set(event.sequence, event);
    return { ...current, snapshotting: true, buffered };
  }
  let next = { ...current, cursor: event.sequence };
  const payload = event.payload as Record<string, unknown>;
  const occurredAt = parseOccurredAt(event.occurredAt);
  if (event.type === 'agentMessageDelta' && typeof payload?.text === 'string') {
    const owner =
      typeof payload.turnId === 'string' ? payload.turnId : (next.activeTurnId ?? undefined);
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : (owner ?? 'live');
    const id = `assistant:${itemId}`;
    const existing = next.messages.find((message) => message.id === id);
    next = {
      ...next,
      lifecycle: next.activeTurnId ? 'working' : next.lifecycle,
      messages: existing
        ? next.messages.map((message) =>
            message.id === id
              ? {
                  ...message,
                  text: message.text + payload.text,
                  ...(payload.phase === 'commentary' || payload.phase === 'final_answer'
                    ? { phase: payload.phase }
                    : {}),
                  complete: payload.phase === 'final_answer' ? true : message.complete,
                  ...(message.occurredAt === undefined && occurredAt !== undefined
                    ? { occurredAt }
                    : {}),
                }
              : message,
          )
        : [
            ...next.messages,
            {
              id,
              role: 'assistant',
              ...(payload.phase === 'commentary' || payload.phase === 'final_answer'
                ? { phase: payload.phase }
                : {}),
              text: payload.text,
              ...(owner ? { turnId: owner } : {}),
              ...(occurredAt !== undefined ? { occurredAt } : {}),
              complete: payload.phase === 'final_answer',
            },
          ],
    };
  } else if (
    (event.type === 'agentMessageStarted' || event.type === 'agentMessageCompleted') &&
    typeof payload.text === 'string'
  ) {
    const itemId =
      typeof payload.itemId === 'string' ? payload.itemId : (next.activeTurnId ?? 'live');
    const id = `assistant:${itemId}`;
    const existing = next.messages.find((message) => message.id === id);
    const complete = event.type === 'agentMessageCompleted';
    const message: ChatMessage = {
      id,
      role: 'assistant',
      text: complete && payload.text ? payload.text : (existing?.text ?? payload.text),
      complete,
      ...(payload.phase === 'commentary' || payload.phase === 'final_answer'
        ? { phase: payload.phase }
        : existing?.phase
          ? { phase: existing.phase }
          : {}),
      ...(typeof payload.turnId === 'string'
        ? { turnId: payload.turnId }
        : existing?.turnId
          ? { turnId: existing.turnId }
          : next.activeTurnId
            ? { turnId: next.activeTurnId }
            : {}),
      ...(existing?.occurredAt !== undefined
        ? { occurredAt: existing.occurredAt }
        : occurredAt !== undefined
          ? { occurredAt }
          : {}),
    };
    next = {
      ...next,
      lifecycle: next.activeTurnId ? 'working' : next.lifecycle,
      messages: existing
        ? next.messages.map((item) => (item.id === id ? message : item))
        : [...next.messages, message],
    };
  } else if (event.type === 'turnCompleted' || event.type === 'turnInterrupted') {
    next = {
      ...next,
      activeTurnId: null,
      lifecycle:
        event.type === 'turnCompleted' || next.lifecycle === 'finished'
          ? 'finished'
          : 'interrupted',
      messages: next.messages.map((message) =>
        message.role === 'assistant' ? { ...message, complete: true } : message,
      ),
    };
  } else if (
    event.type === 'interaction.requested' &&
    typeof payload?.requestId === 'string' &&
    typeof payload.kind === 'string'
  ) {
    const existing = next.interactions.find((item) => item.requestId === payload.requestId);
    if (!existing || existing.state === 'resolved') {
      const requested: ProjectedInteraction = {
        requestId: payload.requestId,
        key: `interaction:${payload.requestId}`,
        kind: payload.kind,
        turnId: typeof payload.turnId === 'string' ? payload.turnId : next.activeTurnId,
        payload: payload.payload,
        state: 'pending',
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      };
      next = {
        ...next,
        interactions: existing
          ? next.interactions.map((item) =>
              item.requestId === payload.requestId ? requested : item,
            )
          : [...next.interactions, requested],
      };
    }
  } else if (event.type === 'interaction.resolved' && typeof payload?.requestId === 'string')
    next = resolveInteraction(next, payload.requestId, payload.outcome);
  else if (
    event.type === 'activity.updated' &&
    typeof payload?.id === 'string' &&
    typeof payload.label === 'string' &&
    typeof payload.detail === 'string'
  )
    next = {
      ...next,
      activities: upsertActivity(next.activities, {
        id: payload.id,
        label: payload.label,
        detail: payload.detail,
        ...(occurredAt !== undefined ? { occurredAt } : {}),
        ...(typeof payload.turnId === 'string'
          ? { turnId: payload.turnId }
          : next.activeTurnId
            ? { turnId: next.activeTurnId }
            : {}),
      }),
    };
  else if (event.type === 'session.updated' && typeof payload?.activeTurnId !== 'undefined') {
    const id = typeof payload.activeTurnId === 'string' ? payload.activeTurnId : null;
    next = { ...next, activeTurnId: id, lifecycle: id ? 'working' : lifecycle(id, next.lifecycle) };
  }
  const audit = auditEventMessage(event);
  if (audit && !next.messages.some((message) => message.id === audit.id))
    next = { ...next, messages: canonicalAutopilotAudit([...next.messages, audit]) };
  return next;
}
export function replayBuffered(current: ChatProjection): ChatProjection {
  let buffer = new Map(current.buffered);
  let next: ChatProjection = { ...current, snapshotting: false, buffered: buffer };
  for (;;) {
    const event = buffer.get(next.cursor + 1);
    if (!event) return { ...next, buffered: buffer, snapshotting: buffer.size > 0 };
    buffer.delete(event.sequence);
    next = applyProjectionEvent({ ...next, buffered: buffer }, event);
    buffer = new Map(next.buffered);
  }
}
export function deriveStatus(projection: ChatProjection): string {
  if (!projection.sessionId) return 'Choose a workspace and start a session.';
  if (projection.snapshotting || projection.lifecycle === 'recoverable')
    return 'Connection interrupted. Reconnecting…';
  if (projection.lifecycle === 'starting') return 'Starting Codex turn…';
  if (projection.lifecycle === 'working') return 'Codex is working…';
  if (projection.lifecycle === 'interrupted') return 'Codex turn interrupted.';
  return 'Ready.';
}
