/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  ChatItem,
  ChatSnapshot,
  SafeInteractionSnapshot,
} from '../../../shared/contracts/chat-snapshot.js';
import { toActivity, type HistoryActivity } from './activity-summary.js';
import type { ChatMessage } from './message-store.js';

export type PromptState = 'submitting' | 'accepted' | 'failed' | 'canonical';
export type TurnLifecycle = 'starting' | 'working' | 'finished' | 'interrupted' | 'recoverable';
export type InteractionState = 'pending' | 'submitting' | 'resolved' | 'failed';
export type SafeInteractionOutcome = 'approved' | 'denied' | 'answered';

export type ProjectedPrompt = Readonly<{
  operationId: string;
  key: string;
  text: string;
  state: PromptState;
  turnId?: string | null;
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
  buffered: new Map(),
});
export const createChatProjection = (sessionId: string | null = null): ChatProjection => ({
  ...empty(),
  sessionId,
});

function messageFromItem(item: ChatItem): ChatMessage | null {
  if ((item.kind !== 'user' && item.kind !== 'agent') || typeof item.text !== 'string') return null;
  return {
    id: `item:${item.id}`,
    role: item.kind === 'user' ? 'user' : 'assistant',
    text: item.text,
    ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
    ...(typeof item.occurredAt === 'number' ? { occurredAt: item.occurredAt } : {}),
    ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
    complete: true,
  };
}
function interaction(snapshot: SafeInteractionSnapshot): ProjectedInteraction {
  return {
    requestId: snapshot.requestId,
    key: `interaction:${snapshot.requestId}`,
    kind: snapshot.kind,
    turnId: snapshot.turnId,
    payload: 'payload' in snapshot ? snapshot.payload : null,
    state: snapshot.resolvedAt ? 'resolved' : 'pending',
    ...(snapshot.resolvedAt ? { attemptedOutcome: snapshot.outcome } : {}),
  };
}
function safeOutcome(
  interaction: ProjectedInteraction | undefined,
  attemptedOutcome: unknown,
): SafeInteractionOutcome | undefined {
  if (
    attemptedOutcome === 'approved' ||
    attemptedOutcome === 'denied' ||
    attemptedOutcome === 'answered'
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
function mergeMessages(
  items: readonly ChatItem[],
  prompts: readonly ProjectedPrompt[],
  previous: readonly ChatMessage[],
): ChatMessage[] {
  const old = new Map(previous.map((message) => [message.id, message]));
  const unmatched = new Set(
    prompts.filter((prompt) => prompt.state !== 'canonical').map((prompt) => prompt.operationId),
  );
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
        return [
          existing && existing.text === message.text
            ? existing
            : { ...message, id: prompt.key, turnId: prompt.turnId ?? message.turnId },
        ];
      }
    }
    if (item.kind === 'agent' && typeof item.turnId === 'string') {
      const live = old.get(`assistant:${item.turnId}`);
      if (live)
        return [
          live.text === message.text && live.phase === message.phase
            ? live
            : { ...message, id: live.id, turnId: message.turnId ?? live.turnId },
        ];
    }
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
      !message.complete &&
      message.role === 'assistant' &&
      !canonical.some((item) => item.id === message.id),
  );
  return unique([...canonical, ...optimistic, ...live]);
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
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.text === 'string',
        ),
      )
      .slice(-200),
    prompts: candidate.prompts
      .filter((prompt): prompt is ProjectedPrompt =>
        Boolean(
          prompt &&
          typeof prompt.operationId === 'string' &&
          typeof prompt.key === 'string' &&
          typeof prompt.text === 'string' &&
          promptStates.includes(prompt.state),
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
          interactionStates.includes(item.state),
        ),
      )
      .slice(-200),
  };
}

/** Accepts authoritative history without discarding a still-pending local operation. */
export function acceptSnapshot(current: ChatProjection, snapshot: ChatSnapshot): ChatProjection {
  if (!Number.isInteger(snapshot.baseSequence) || snapshot.baseSequence < 0) return current;
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
      return prior?.state === 'resolved' ? prior : next;
    }),
  );
  const activities = unique(
    snapshot.items.flatMap((item) => {
      const activity = toActivity(item);
      return activity ? [{ ...activity, key: `activity:${activity.id}` }] : [];
    }) as Array<HistoryActivity & { key: string }>,
  ).map((item) => ({ id: item.id, label: item.label, detail: item.detail }));
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
    messages: mergeMessages(snapshot.items, prompts, current.messages),
    activities,
    interactions,
    buffered: new Map(
      [...current.buffered].filter(([sequence]) => sequence > snapshot.baseSequence),
    ),
  };
  return replayBuffered(projected);
}

export function beginSnapshot(current: ChatProjection): ChatProjection {
  return { ...current, snapshotting: true };
}
export function queuePrompt(
  current: ChatProjection,
  operationId: string,
  text: string,
): ChatProjection {
  if (!text.trim() || current.prompts.some((prompt) => prompt.operationId === operationId))
    return current;
  const prompt: ProjectedPrompt = {
    operationId,
    key: `prompt:${operationId}`,
    text,
    state: 'submitting',
    turnId: null,
  };
  return {
    ...current,
    lifecycle: 'starting',
    prompts: [...current.prompts, prompt],
    messages: [...current.messages, { id: prompt.key, role: 'user', text, complete: false }],
  };
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
  if (
    (event.type === 'agentMessageDelta' || event.type === 'agentMessageCompleted') &&
    typeof payload?.text === 'string'
  ) {
    const id = `assistant:${next.activeTurnId ?? 'live'}`;
    const existing = next.messages.find((message) => message.id === id);
    const final = payload.phase === 'final_answer' || event.type === 'agentMessageCompleted';
    next = {
      ...next,
      lifecycle: next.activeTurnId ? 'working' : next.lifecycle,
      messages: existing
        ? next.messages.map((message) =>
            message.id === id
              ? {
                  ...message,
                  text: message.text + payload.text,
                  phase: final ? 'final_answer' : message.phase,
                  complete: final,
                }
              : message,
          )
        : [
            ...next.messages,
            {
              id,
              role: 'assistant',
              phase: final ? 'final_answer' : 'commentary',
              text: payload.text,
              complete: final,
            },
          ],
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
    if (!next.interactions.some((item) => item.requestId === payload.requestId))
      next = {
        ...next,
        interactions: [
          ...next.interactions,
          {
            requestId: payload.requestId,
            key: `interaction:${payload.requestId}`,
            kind: payload.kind,
            turnId: typeof payload.turnId === 'string' ? payload.turnId : next.activeTurnId,
            payload: payload.payload,
            state: 'pending',
          },
        ],
      };
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
      activities: [
        ...next.activities.filter((activity) => activity.id !== payload.id),
        { id: payload.id, label: payload.label, detail: payload.detail },
      ],
    };
  else if (event.type === 'session.updated' && typeof payload?.activeTurnId !== 'undefined') {
    const id = typeof payload.activeTurnId === 'string' ? payload.activeTurnId : null;
    next = { ...next, activeTurnId: id, lifecycle: id ? 'working' : lifecycle(id, next.lifecycle) };
  }
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
