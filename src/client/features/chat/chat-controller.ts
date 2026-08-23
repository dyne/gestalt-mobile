/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  ChatSnapshot,
  SafeInteractionOutcome,
} from '../../../shared/contracts/chat-snapshot.js';
import { createIdempotencyKey } from '../sessions/idempotency-key.js';
import {
  acceptSnapshot,
  applyProjectionEvent,
  beginInteraction,
  beginSnapshot,
  createChatProjection,
  deriveStatus,
  failInteraction,
  failPrompt,
  hydrateCache,
  promotePrompt,
  queuePrompt,
  resolveInteraction,
  type ChatProjection,
  type ProjectionEvent,
} from './chat-projection.js';

type Timer = ReturnType<typeof setTimeout>;
export type ChatViewState = Readonly<ChatProjection & { status: string; starting: boolean }>;
export type ChatRelay = Readonly<{
  getHistory(sessionId: string): Promise<unknown>;
  startTurn(sessionId: string, text: string, key?: string): Promise<{ activeTurnId?: string }>;
  interruptTurn(sessionId: string, turnId: string): Promise<void>;
  respondInteraction(
    sessionId: string,
    requestId: string,
    value: unknown,
    key?: string,
  ): Promise<{ outcome?: SafeInteractionOutcome } | void>;
}>;
export type ChatCache = Readonly<{
  read(sessionId: string): Promise<unknown>;
  write(sessionId: string, projection: ChatProjection): Promise<void>;
}>;
export type ChatControllerOptions = Readonly<{
  relay: ChatRelay;
  publish(view: ChatViewState): void;
  websocket?: (url: string) => WebSocket;
  cache?: ChatCache;
  location?: Location;
  document?: Document;
  window?: Window;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  createKey?: () => string;
  now?: () => number;
  onSessionEvent?: (event: ProjectionEvent) => void;
  onRelayEvent?: (event: ProjectionEvent) => void;
  onHistoryError?: (error: unknown) => void;
  onSendError?: (error: unknown, operationId: string) => void;
  onSendAccepted?: (operationId: string) => void;
}>;
const noCache: ChatCache = { read: async () => null, write: async () => {} };
const historyRetryDelays = [250, 750, 1_500] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';
export const isChatItem = (value: unknown): value is ChatSnapshot['items'][number] =>
  object(value) && typeof value.id === 'string' && typeof value.kind === 'string';
export const isChatTurn = (value: unknown): value is ChatSnapshot['turns'][number] =>
  object(value) &&
  typeof value.id === 'string' &&
  Array.isArray(value.items) &&
  value.items.every(isChatItem) &&
  (value.startedAt === null || typeof value.startedAt === 'number') &&
  (value.completedAt === null || typeof value.completedAt === 'number');
export const isSafeInteractionSnapshot = (
  value: unknown,
): value is ChatSnapshot['interactions'][number] => {
  if (
    !object(value) ||
    typeof value.requestId !== 'string' ||
    typeof value.kind !== 'string' ||
    !(value.turnId === null || typeof value.turnId === 'string') ||
    !(value.requestedAt === null || typeof value.requestedAt === 'string')
  )
    return false;
  if (value.resolvedAt === null) return Object.hasOwn(value, 'payload');
  return (
    typeof value.resolvedAt === 'string' &&
    (value.outcome === 'approved' ||
      value.outcome === 'denied' ||
      value.outcome === 'answered' ||
      value.outcome === 'dismissed' ||
      value.outcome === 'failed') &&
    !Object.hasOwn(value, 'payload')
  );
};
const isAutopilotAuditRecord = (value: unknown): boolean =>
  object(value) &&
  typeof value.id === 'string' &&
  typeof value.label === 'string' &&
  typeof value.occurredAt === 'number' &&
  Number.isFinite(value.occurredAt) &&
  (value.controlId === undefined || typeof value.controlId === 'string');
export const decodeChatSnapshot = (value: unknown): ChatSnapshot | null => {
  if (
    !object(value) ||
    !Number.isInteger(value.baseSequence) ||
    (value.baseSequence as number) < 0 ||
    !(value.activeTurnId === null || typeof value.activeTurnId === 'string') ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.turns) ||
    !Array.isArray(value.interactions) ||
    !value.items.every(isChatItem) ||
    !value.turns.every(isChatTurn) ||
    !value.interactions.every(isSafeInteractionSnapshot) ||
    (value.autopilotAudit !== undefined &&
      (!Array.isArray(value.autopilotAudit) ||
        !value.autopilotAudit.every(isAutopilotAuditRecord))) ||
    (value.autopilotAuditTruncated !== undefined &&
      typeof value.autopilotAuditTruncated !== 'boolean') ||
    (value.currentSequence !== undefined &&
      (!Number.isInteger(value.currentSequence) || (value.currentSequence as number) < 0))
  )
    return null;
  return value as ChatSnapshot;
};

/** One selected-session transport owner. All async publications are generation scoped. */
export class ChatController {
  #projection = createChatProjection();
  #sessionId: string | null = null;
  #generation = 0;
  #authoritativeGeneration = -1;
  #socket: WebSocket | null = null;
  #snapshot: { id: string; generation: number; promise: Promise<void> } | null = null;
  #historyRetry: Timer | null = null;
  #historyFailures = 0;
  #historyErrorReported = false;
  #reconnect: Timer | null = null;
  #attempt = 0;
  #disposed = false;
  #commands = new Set<string>();
  #interactionCommands = new Set<string>();
  #options: Required<
    Pick<
      ChatControllerOptions,
      | 'websocket'
      | 'cache'
      | 'location'
      | 'document'
      | 'window'
      | 'setTimeout'
      | 'clearTimeout'
      | 'createKey'
      | 'now'
    >
  > &
    ChatControllerOptions;
  constructor(options: ChatControllerOptions) {
    this.#options = {
      ...options,
      websocket: options.websocket ?? ((url) => new WebSocket(url)),
      cache: options.cache ?? noCache,
      location: options.location ?? location,
      document: options.document ?? document,
      window: options.window ?? window,
      setTimeout: options.setTimeout ?? ((fn, delay) => setTimeout(fn, delay)),
      clearTimeout: options.clearTimeout ?? ((timer) => clearTimeout(timer)),
      createKey: options.createKey ?? createIdempotencyKey,
      now: options.now ?? Date.now,
    };
    this.#options.document.addEventListener('visibilitychange', this.#foreground);
    this.#options.window.addEventListener('focus', this.#foreground);
  }
  get view(): ChatViewState {
    return Object.freeze({
      ...this.#projection,
      status: deriveStatus(this.#projection),
      starting: this.#projection.lifecycle === 'starting',
    });
  }
  select(sessionId: string | null): void {
    if (this.#disposed || this.#sessionId === sessionId) return;
    this.#stop();
    this.#sessionId = sessionId;
    const generation = ++this.#generation;
    this.#projection = createChatProjection(sessionId);
    this.#publish();
    if (sessionId) void this.#hydrate(sessionId, generation);
  }
  async send(text: string, operationId = this.#options.createKey()): Promise<void> {
    const id = this.#sessionId;
    const generation = this.#generation;
    const command = `${id}:${generation}:${operationId}`;
    if (!id || !text.trim() || this.#projection.activeTurnId || this.#commands.has(command)) return;
    this.#commands.add(command);
    this.#set(queuePrompt(this.#projection, operationId, text.trim(), this.#options.now()));
    try {
      const turn = await this.#options.relay.startTurn(id, text.trim(), operationId);
      if (this.#current(id, generation)) {
        this.#set(promotePrompt(this.#projection, operationId, turn.activeTurnId ?? null));
        this.#options.onSendAccepted?.(operationId);
      }
    } catch (error: unknown) {
      if (this.#current(id, generation)) {
        this.#set(failPrompt(this.#projection, operationId));
        this.#options.onSendError?.(error, operationId);
      }
    } finally {
      this.#commands.delete(command);
    }
  }
  async retryPrompt(operationId: string): Promise<void> {
    const prompt = this.#projection.prompts.find((item) => item.operationId === operationId);
    if (prompt?.state === 'failed') await this.send(prompt.text, operationId);
  }
  async interrupt(): Promise<void> {
    const id = this.#sessionId;
    const turn = this.#projection.activeTurnId;
    if (!id || !turn) return;
    try {
      await this.#options.relay.interruptTurn(id, turn);
    } catch {
      /* ambiguity converges through snapshot/event replay */
    }
  }
  async respond(
    requestId: string,
    value: unknown,
    operationId = this.#options.createKey(),
  ): Promise<void> {
    const id = this.#sessionId;
    const generation = this.#generation;
    const interaction = this.#projection.interactions.find((item) => item.requestId === requestId);
    const key = interaction?.operationId ?? operationId;
    const command = `${id}:${generation}:${key}`;
    if (
      !id ||
      !interaction ||
      interaction.state === 'resolved' ||
      interaction.state === 'submitting' ||
      this.#interactionCommands.has(command)
    )
      return;
    this.#interactionCommands.add(command);
    this.#set(beginInteraction(this.#projection, requestId, key));
    try {
      const result = await this.#options.relay.respondInteraction(id, requestId, value, key);
      const outcome =
        result &&
        (result.outcome === 'approved' ||
          result.outcome === 'denied' ||
          result.outcome === 'answered' ||
          result.outcome === 'dismissed' ||
          result.outcome === 'failed')
          ? result.outcome
          : value;
      if (this.#current(id, generation))
        this.#set(resolveInteraction(this.#projection, requestId, outcome));
    } catch {
      if (this.#current(id, generation))
        this.#set(failInteraction(this.#projection, requestId, value));
    } finally {
      this.#interactionCommands.delete(command);
    }
  }
  async retryInteraction(requestId: string, replacementValue?: unknown): Promise<void> {
    const interaction = this.#projection.interactions.find((item) => item.requestId === requestId);
    if (interaction?.state !== 'failed' || !interaction.operationId) return;
    const attempted = replacementValue ?? interaction.attemptedOutcome;
    const value =
      attempted === 'approved'
        ? { decision: 'accept' }
        : attempted === 'denied'
          ? { decision: 'decline' }
          : attempted;
    if (value === undefined) return;
    await this.respond(requestId, value, interaction.operationId);
  }
  refresh(): void {
    if (this.#sessionId) void this.#takeSnapshot(this.#sessionId, this.#generation);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop();
    this.#options.document.removeEventListener('visibilitychange', this.#foreground);
    this.#options.window.removeEventListener('focus', this.#foreground);
  }
  #foreground = (): void => {
    if (this.#options.document.visibilityState === 'visible') this.refresh();
  };
  async #hydrate(id: string, generation: number): Promise<void> {
    void this.#takeSnapshot(id, generation);
    this.#open(id, generation);
    const cached = await this.#options.cache.read(id).catch(() => null);
    if (!this.#current(id, generation) || this.#authoritativeGeneration === generation || !cached)
      return;
    this.#projection = hydrateCache(id, cached);
    this.#publish();
  }
  #open(id: string, generation: number): void {
    if (!this.#current(id, generation) || this.#socket) return;
    const scheme = this.#options.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = this.#options.websocket(
        `${scheme}//${this.#options.location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${this.#projection.cursor}`,
      );
    } catch {
      this.#projection = { ...this.#projection, lifecycle: 'recoverable' };
      this.#publish();
      this.#reconnect = this.#options.setTimeout(
        () => this.#open(id, generation),
        Math.min(1000 * 2 ** this.#attempt++, 10_000),
      );
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#current(id, generation) && this.#socket === socket) {
        this.#attempt = 0;
        void this.#takeSnapshot(id, generation);
      }
    };
    socket.onmessage = (event) => this.#receive(id, generation, String(event.data));
    socket.onclose = () => {
      if (!this.#current(id, generation) || this.#socket !== socket) return;
      this.#socket = null;
      this.#reconnect = this.#options.setTimeout(
        () => this.#open(id, generation),
        Math.min(1000 * 2 ** this.#attempt++, 10_000),
      );
    };
  }
  #receive(id: string, generation: number, raw: string): void {
    if (!this.#current(id, generation)) return;
    let envelope: { type?: unknown; event?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      return;
    }
    if (envelope.type === 'relay.resyncRequired') {
      void this.#takeSnapshot(id, generation);
      return;
    }
    if (envelope.type !== 'relay.event' || !envelope.event || typeof envelope.event !== 'object')
      return;
    const event = envelope.event as ProjectionEvent;
    if (
      !Number.isInteger(event.sequence) ||
      typeof event.type !== 'string' ||
      !this.#validEvent(event)
    )
      return;
    const next = applyProjectionEvent(this.#projection, event);
    this.#set(next);
    this.#options.onRelayEvent?.(event);
    if (
      event.type === 'session.updated' ||
      event.type === 'plan.updated' ||
      event.type === 'plan.closed' ||
      event.type === 'agent.activity.updated' ||
      event.type === 'autopilot.updated' ||
      event.type === 'org-plan.attention-required' ||
      event.type === 'org-plan.attention-resolved'
    )
      this.#options.onSessionEvent?.(event);
    if (next.snapshotting) void this.#takeSnapshot(id, generation);
  }
  #validEvent(event: ProjectionEvent): boolean {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object')
      return (
        event.type === 'turnCompleted' ||
        event.type === 'turnInterrupted' ||
        event.type === 'plan.closed'
      );
    const value = payload as Record<string, unknown>;
    if (event.type === 'agentMessageDelta') return typeof value.text === 'string';
    if (event.type === 'agentMessageStarted' || event.type === 'agentMessageCompleted')
      return typeof value.text === 'string';
    if (event.type === 'interaction.requested')
      return typeof value.requestId === 'string' && typeof value.kind === 'string';
    if (event.type === 'interaction.resolved') return typeof value.requestId === 'string';
    if (event.type === 'session.updated')
      return value.activeTurnId === null || typeof value.activeTurnId === 'string';
    if (event.type === 'activity.updated')
      return (
        typeof value.id === 'string' &&
        typeof value.label === 'string' &&
        typeof value.detail === 'string'
      );
    if (event.type === 'agent.activity.updated')
      return (
        typeof value.sessionId === 'string' && Boolean(value.root) && Array.isArray(value.subagents)
      );
    if (
      event.type === 'autopilot.updated' ||
      event.type === 'org-plan.attention-required' ||
      event.type === 'org-plan.attention-resolved' ||
      [
        'autopilot.continuation-scheduled',
        'autopilot.control-issued',
        'autopilot.turn-started',
        'autopilot.turn-failed',
      ].includes(event.type)
    )
      return true;
    return event.type === 'plan.updated' || event.type === 'plan.closed';
  }
  #takeSnapshot(id: string, generation: number): Promise<void> {
    if (this.#snapshot?.id === id && this.#snapshot.generation === generation)
      return this.#snapshot.promise;
    if (!this.#current(id, generation)) return Promise.resolve();
    const recovering = this.#projection.snapshotting && this.#projection.buffered.size > 0;
    this.#projection = beginSnapshot(this.#projection);
    this.#publish();
    const promise = this.#options.relay
      .getHistory(id)
      .then((history) => {
        const decoded = decodeChatSnapshot(history);
        if (!this.#current(id, generation)) return;
        if (!decoded) {
          this.#set({ ...this.#projection, snapshotting: false, lifecycle: 'recoverable' });
          return;
        }
        this.#historyFailures = 0;
        this.#historyErrorReported = false;
        if (this.#historyRetry) this.#options.clearTimeout(this.#historyRetry);
        this.#historyRetry = null;
        this.#authoritativeGeneration = generation;
        this.#set(acceptSnapshot(this.#projection, decoded));
        if (recovering) this.#replaceSocket(id, generation);
      })
      .catch((error: unknown) => {
        if (this.#current(id, generation)) {
          this.#set({ ...this.#projection, snapshotting: false, lifecycle: 'recoverable' });
          const delay = historyRetryDelays[this.#historyFailures++];
          if (delay !== undefined) this.#scheduleHistoryRetry(id, generation, delay);
          else if (!this.#historyErrorReported) {
            this.#historyErrorReported = true;
            this.#options.onHistoryError?.(error);
          }
        }
      })
      .finally(() => {
        if (this.#snapshot?.promise === promise) {
          this.#snapshot = null;
          if (this.#current(id, generation) && this.#projection.snapshotting)
            void this.#takeSnapshot(id, generation);
        }
      });
    this.#snapshot = { id, generation, promise };
    return promise;
  }
  #scheduleHistoryRetry(id: string, generation: number, delay: number): void {
    if (this.#historyRetry) this.#options.clearTimeout(this.#historyRetry);
    const timer = this.#options.setTimeout(() => {
      if (this.#historyRetry !== timer) return;
      this.#historyRetry = null;
      if (this.#current(id, generation)) void this.#takeSnapshot(id, generation);
    }, delay);
    this.#historyRetry = timer;
  }
  #replaceSocket(id: string, generation: number): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    if (this.#reconnect) this.#options.clearTimeout(this.#reconnect);
    this.#reconnect = null;
    this.#open(id, generation);
  }
  #set(next: ChatProjection): void {
    this.#projection = next;
    this.#publish();
    if (this.#sessionId)
      void this.#options.cache.write(this.#sessionId, this.#projection).catch(() => {});
  }
  #publish(): void {
    this.#options.publish(this.view);
  }
  #current(id: string, generation: number): boolean {
    return !this.#disposed && this.#sessionId === id && this.#generation === generation;
  }
  #stop(): void {
    if (this.#reconnect) this.#options.clearTimeout(this.#reconnect);
    this.#reconnect = null;
    if (this.#historyRetry) this.#options.clearTimeout(this.#historyRetry);
    this.#historyRetry = null;
    this.#historyFailures = 0;
    this.#historyErrorReported = false;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }
}
