/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';
import type { HistoryTurn } from '../../features/sessions/get-history/history-mapper.js';
import {
  normalizeSkillProfileName,
  type SkillSelection,
} from '../../features/skills/model/skill-profile.js';
import {
  WriterAcquisitionError,
  type WriterAcquisition,
} from '../../features/sessions/application/writer-acquisition.js';
import type { RestoreSessionResult } from '../codex/session-runtime.js';
import { isKimiWebError } from './kimi-errors.js';
import { KimiWsClient, type KimiWsEvent } from './kimi-ws-client.js';
import type { KimiServerHandle, KimiWebServerManager } from './kimi-web-server-manager.js';
import {
  approvalToServerRequest,
  decodeApprovalItems,
  decodeQuestionItems,
  kimiApprovalDecision,
  kimiQuestionAnswers,
  questionToServerRequest,
  type KimiQuestionItem,
} from './kimi-server-request.js';

export type KimiNotificationOrigin = Readonly<{
  kind: 'root' | 'child';
  physicalTurnId?: string;
}>;

type PendingInteraction = Readonly<{
  kind: 'approval' | 'question';
  kimiId: string;
  settling: boolean;
}>;

type SessionResource = {
  sessionId: string;
  profileKey: string;
  threadId: string;
  active: boolean;
  explicitShutdown: boolean;
  cursor: number;
  /** Prompt ids submitted but not yet bound to a kimi turn number (FIFO). */
  pendingPrompts: string[];
  /** `${agentId}:${turnNumber}` → prompt id. */
  agentTurns: Map<string, string>;
  /** Prompt id of the turn kimi is currently running, if any. */
  activePromptId: string | null;
  childAgents: Set<string>;
  mainAgentId: string | null;
  pendingInteractions: Map<string, PendingInteraction>;
  interactionSequence: number;
  pollInFlight: 'approvals' | 'questions' | null;
};

type ProfileConnection = {
  client: KimiWsClient;
  sessions: Set<string>;
  eventUnsub: () => void;
  closeUnsub: () => void;
};

const KIMI_SESSION_NOT_RUNNING = 'KIMI_SESSION_NOT_RUNNING';
const KIMI_UNSUPPORTED = 'KIMI_UNSUPPORTED';

/**
 * Drives relay sessions through a gestalt-owned `kimi web` server. Implements
 * the same runtime surface the composition consumes from CodexSessionRuntime
 * for the core chat path (start/restore/turns/steering/interrupt/history/
 * approvals/questions/release). Codex-only surfaces — autopilot executors,
 * supervised-plan measurement, child-process reconciliation — throw
 * `KIMI_UNSUPPORTED` and are never offered for kimi sessions upstream.
 */
export class KimiSessionRuntime {
  private readonly sessions = new Map<string, SessionResource>();
  private readonly connections = new Map<string, ProfileConnection>();
  private readonly writerAcquisitions = new Map<string, Promise<WriterAcquisition>>();
  private readonly historyReads = new Map<
    string,
    Promise<{ turns: HistoryTurn[]; activeTurnId: string | null }>
  >();

  public constructor(
    private readonly input: {
      servers: KimiWebServerManager;
      skillsFor(
        session: RelaySessionSnapshot,
      ): Promise<SkillSelection | undefined> | SkillSelection | undefined;
      onNotification(sessionId: string, event: KimiWsEvent, origin: KimiNotificationOrigin): void;
      onServerRequest(
        sessionId: string,
        request: { id: number; method: string; params: unknown },
        origin: KimiNotificationOrigin,
      ): boolean | Promise<boolean>;
      onExit?(sessionId: string): void;
      /** Test seam; production always constructs a real ws client. */
      wsClientFor?(handle: KimiServerHandle): KimiWsClient;
    },
  ) {}

  /**
   * Per-session translation context for the event normalizer and activity
   * facts decoder: kimi per-agent turn numbers resolve to prompt turn ids,
   * and spawned subagent ids are tracked as child agents.
   */
  public eventContext(sessionId: string): {
    resolveTurnId(agentId: string, turnNumber: number): string | null;
    isChildAgent(agentId: string): boolean;
  } {
    const resource = this.sessions.get(sessionId);
    if (!resource) return { resolveTurnId: () => null, isChildAgent: () => false };
    return {
      resolveTurnId: (agentId, turnNumber) =>
        resource.agentTurns.get(`${agentId}:${turnNumber}`) ?? null,
      isChildAgent: (agentId) => resource.childAgents.has(agentId),
    };
  }

  public async start(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    const handle = await this.ensureServer(session);
    const created = (await handle.client.post('/api/v1/sessions', {
      metadata: { cwd: session.workspacePath },
    })) as { id?: string };
    if (!created.id || typeof created.id !== 'string')
      throw new Error('KIMI_SESSION_CREATE_FAILED');
    await this.applyProfile(handle, created.id, session);
    await this.attachResource(session, created.id, handle);
    return RelaySession.rehydrate(session).bindThread(created.id, now).snapshot;
  }

  public stop(sessionId: string): void {
    const resource = this.sessions.get(sessionId);
    if (!resource) return;
    resource.explicitShutdown = true;
    this.detach(sessionId);
  }

  public async release(sessionId: string): Promise<void> {
    const resource = this.sessions.get(sessionId);
    if (resource) resource.explicitShutdown = true;
    await this.detach(sessionId);
  }

  public async recycle(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    this.stop(session.id);
    return this.restore(session, now);
  }

  public stopAll(): void {
    for (const resource of this.sessions.values()) resource.explicitShutdown = true;
    for (const sessionId of [...this.sessions.keys()]) this.detach(sessionId);
  }

  public ownsWriter(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active === true;
  }

  public async ensureWriter(
    session: RelaySessionSnapshot,
    now: string,
  ): Promise<WriterAcquisition> {
    if (this.ownsWriter(session.id)) return { session, replacementCreated: false };
    const inflight = this.writerAcquisitions.get(session.id);
    if (inflight) return inflight;
    const acquisition = this.acquireWriter(session, now);
    this.writerAcquisitions.set(session.id, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.writerAcquisitions.get(session.id) === acquisition)
        this.writerAcquisitions.delete(session.id);
    }
  }

  public async startTurn(
    session: RelaySessionSnapshot,
    text: string,
    clientUserMessageId: string | undefined,
    now: string,
  ): Promise<RelaySessionSnapshot> {
    const resource = this.requireResource(session);
    const promptId = clientUserMessageId ?? randomUUID();
    await this.submitPrompt(resource, promptId, text, session.model);
    return RelaySession.rehydrate(session).startTurn(promptId, now).snapshot;
  }

  /** kimi queues prompts server-side while a turn runs; submitPrompt steers
   * the queued prompt into the active turn, which is the steering equivalent. */
  public async queueTurnInput(
    session: RelaySessionSnapshot,
    _turnId: string,
    text: string,
    clientUserMessageId?: string,
  ): Promise<void> {
    const resource = this.requireResource(session);
    await this.submitPrompt(resource, clientUserMessageId ?? randomUUID(), text, session.model);
  }

  public async interruptTurn(session: RelaySessionSnapshot, turnId: string): Promise<void> {
    const resource = this.requireResource(session);
    const handle = this.input.servers.get(resource.profileKey);
    if (!handle) throw new Error(KIMI_SESSION_NOT_RUNNING);
    await handle.client.post(`/api/v1/sessions/${resource.threadId}/prompts/${turnId}:abort`);
  }

  public async readHistory(session: RelaySessionSnapshot): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    if (!session.threadId) throw new Error('KIMI_THREAD_ID_MISSING');
    const owned = this.sessions.get(session.id);
    if (owned) return this.readHistoryFrom(owned);
    const existing = this.historyReads.get(session.id);
    if (existing) return existing;
    const read = this.readDetachedHistory(session);
    this.historyReads.set(session.id, read);
    try {
      return await read;
    } finally {
      if (this.historyReads.get(session.id) === read) this.historyReads.delete(session.id);
    }
  }

  public resolveServerRequest(sessionId: string, requestId: string, result: unknown): boolean {
    const resource = this.sessions.get(sessionId);
    const pending = resource?.pendingInteractions.get(requestId);
    if (!resource || !pending || pending.settling) return false;
    void this.resolveInteraction(resource, requestId, pending, result).catch(() => {});
    return true;
  }

  public rejectServerRequest(sessionId: string, requestId: string): boolean {
    const resource = this.sessions.get(sessionId);
    const pending = resource?.pendingInteractions.get(requestId);
    if (!resource || !pending || pending.settling) return false;
    void this.resolveInteraction(resource, requestId, pending, 'cancel').catch(() => {});
    return true;
  }

  public abandonServerRequest(sessionId: string, requestId: string): boolean {
    return this.sessions.get(sessionId)?.pendingInteractions.delete(requestId) === true;
  }

  public attentionWriterState(
    sessionId: string,
    requestId: string,
  ): 'available' | 'cleared' | 'unavailable' {
    const resource = this.sessions.get(sessionId);
    if (!resource || !resource.active) return 'unavailable';
    const pending = resource.pendingInteractions.get(requestId);
    return pending && !pending.settling ? 'available' : 'cleared';
  }

  public async restore(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    return (await this.restoreWithOutcome(session, now)).session;
  }

  public async restoreWithOutcome(
    session: RelaySessionSnapshot,
    now: string,
  ): Promise<RestoreSessionResult> {
    try {
      const restored = await this.attachExisting(session);
      return { session: restored, historyUnavailable: false, replacementCreated: false };
    } catch (error) {
      if (!isKimiSessionMissing(error)) throw error;
      // The kimi session disappeared server-side (pruned or share-dir loss):
      // bind a replacement thread, mirroring the codex missing-rollout policy.
      const replacement = await this.start(session, now);
      return { session: replacement, historyUnavailable: true, replacementCreated: true };
    }
  }

  // --- Codex-only surfaces: kimi sessions never reach these upstream. ---

  public async startExecutorTurn(): Promise<string> {
    throw new Error(KIMI_UNSUPPORTED);
  }

  public async interruptExecutor(): Promise<boolean> {
    throw new Error(KIMI_UNSUPPORTED);
  }

  public async listDirectChildren(): Promise<readonly never[]> {
    return [];
  }

  public async inspectChildProcesses(): Promise<readonly never[]> {
    return [];
  }

  public consumeChildProcessResult(): void {
    throw new Error(KIMI_UNSUPPORTED);
  }

  public async terminateChildProcess(): Promise<boolean> {
    throw new Error(KIMI_UNSUPPORTED);
  }

  public async readPlanMeasurement(): Promise<never> {
    throw new Error(KIMI_UNSUPPORTED);
  }

  public authorizePlanMeasurement(): boolean {
    return false;
  }

  public async syncThreadPlanName(): Promise<void> {}

  public async watchPlanStatus(): Promise<void> {}

  // --- internals ---

  private async acquireWriter(
    session: RelaySessionSnapshot,
    now: string,
  ): Promise<WriterAcquisition> {
    try {
      const restored = await this.restoreWithOutcome(session, now);
      return { session: restored.session, replacementCreated: restored.replacementCreated };
    } catch (error) {
      throw classifyWriterAcquisitionFailure(error);
    }
  }

  /**
   * Servers are keyed by the canonical skill selection: sessions sharing one
   * effective selection share one kimi web process. The empty (native)
   * selection uses the stable `default` key; anything else uses a short hash
   * of its path-sorted entries (hex fits the skill-profile name pattern).
   */
  private profileKey(session: RelaySessionSnapshot): string {
    const effective = session.effectiveSkillSelection;
    const selection = effective?.skills ?? [];
    if (effective?.selectedProfileName)
      return normalizeSkillProfileName(effective.selectedProfileName);
    if (!selection.length) return 'default';
    const canonical = JSON.stringify([...selection].sort((a, b) => a.path.localeCompare(b.path)));
    return `sel-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
  }

  private async ensureServer(session: RelaySessionSnapshot): Promise<KimiServerHandle> {
    const skills = await this.input.skillsFor(session);
    return this.input.servers.ensure(
      this.profileKey(session),
      skills ?? session.effectiveSkillSelection?.skills ?? [],
    );
  }

  private async applyProfile(
    handle: KimiServerHandle,
    threadId: string,
    session: RelaySessionSnapshot,
  ): Promise<void> {
    await handle.client.post(`/api/v1/sessions/${threadId}/profile`, {
      agent_config: {
        ...(session.model ? { model: session.model } : {}),
        permission_mode: kimiPermissionMode(session),
      },
    });
  }

  private async attachResource(
    session: RelaySessionSnapshot,
    threadId: string,
    handle: KimiServerHandle,
  ): Promise<SessionResource> {
    await this.detach(session.id);
    const resource: SessionResource = {
      sessionId: session.id,
      profileKey: handle.profileKey,
      threadId,
      active: true,
      explicitShutdown: false,
      cursor: 0,
      pendingPrompts: [],
      agentTurns: new Map(),
      activePromptId: null,
      childAgents: new Set(),
      mainAgentId: null,
      pendingInteractions: new Map(),
      interactionSequence: 0,
      pollInFlight: null,
    };
    this.sessions.set(session.id, resource);
    await this.subscribe(resource, handle);
    return resource;
  }

  /** Attaches to the durable kimi session recorded on the relay snapshot. */
  private async attachExisting(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot> {
    if (!session.threadId) throw new Error('KIMI_THREAD_ID_MISSING');
    const handle = await this.ensureServer(session);
    await handle.client.get(`/api/v1/sessions/${session.threadId}`);
    await this.applyProfile(handle, session.threadId, session);
    await this.attachResource(session, session.threadId, handle);
    return session;
  }

  private async subscribe(resource: SessionResource, handle: KimiServerHandle): Promise<void> {
    const connection = await this.ensureConnection(handle);
    connection.sessions.add(resource.sessionId);
    await connection.client.subscribe([resource.threadId], {
      [resource.threadId]: { seq: resource.cursor },
    });
  }

  private async ensureConnection(handle: KimiServerHandle): Promise<ProfileConnection> {
    const existing = this.connections.get(handle.profileKey);
    if (existing) return existing;
    const client =
      this.input.wsClientFor?.(handle) ?? new KimiWsClient(handle.baseUrl, handle.token);
    const connection: ProfileConnection = {
      client,
      sessions: new Set(),
      eventUnsub: client.onEvent((event) => this.dispatchEvent(handle.profileKey, event)),
      closeUnsub: client.onClose(() => this.handleConnectionClose(handle.profileKey)),
    };
    this.connections.set(handle.profileKey, connection);
    try {
      await client.connect();
    } catch (error) {
      connection.eventUnsub();
      connection.closeUnsub();
      this.connections.delete(handle.profileKey);
      throw error;
    }
    return connection;
  }

  private handleConnectionClose(profileKey: string): void {
    const connection = this.connections.get(profileKey);
    if (!connection) return;
    this.connections.delete(profileKey);
    for (const sessionId of connection.sessions) {
      const resource = this.sessions.get(sessionId);
      if (resource) resource.active = false;
    }
    for (const sessionId of connection.sessions) this.input.onExit?.(sessionId);
  }

  private dispatchEvent(profileKey: string, event: KimiWsEvent): Promise<void> | void {
    const sessionId = this.relaySessionId(profileKey, event.session_id);
    const resource = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !resource) return;
    if (typeof event.seq === 'number' && event.seq > resource.cursor) resource.cursor = event.seq;
    this.consumeProtocolEvent(resource, event);
    const origin = this.originFor(resource, event);
    this.input.onNotification(sessionId, event, origin);
  }

  /** Maps a kimi session id back to the owning relay session on this connection. */
  private relaySessionId(profileKey: string, threadId: string | undefined): string | null {
    if (!threadId) return null;
    for (const resource of this.sessions.values()) {
      if (resource.profileKey === profileKey && resource.threadId === threadId)
        return resource.sessionId;
    }
    return null;
  }

  private originFor(resource: SessionResource, event: KimiWsEvent): KimiNotificationOrigin {
    const agentId = agentIdOf(event.payload);
    if (agentId && resource.childAgents.has(agentId)) {
      const turnNumber = turnNumberOf(event.payload);
      return {
        kind: 'child',
        ...(agentId && turnNumber !== null ? { physicalTurnId: `${agentId}:${turnNumber}` } : {}),
      };
    }
    return { kind: 'root' };
  }

  /** Consumes protocol facts the runtime itself owns (turn/prompt bindings, interactions). */
  private consumeProtocolEvent(resource: SessionResource, event: KimiWsEvent): void {
    const payload = record(event.payload);
    if (!payload) return;
    switch (payload.type) {
      case 'turn.started': {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
        const turnNumber = safeTurnNumber(payload.turnId);
        if (!agentId || turnNumber === null) break;
        if (resource.mainAgentId === null && resource.pendingPrompts.length) {
          resource.mainAgentId = agentId;
        }
        if (agentId !== resource.mainAgentId) {
          resource.childAgents.add(agentId);
          break;
        }
        const promptId = resource.pendingPrompts.shift();
        if (promptId) {
          resource.agentTurns.set(`${agentId}:${turnNumber}`, promptId);
          resource.activePromptId = promptId;
        }
        break;
      }
      case 'prompt.completed':
      case 'prompt.aborted': {
        const promptId = typeof payload.promptId === 'string' ? payload.promptId : null;
        if (!promptId) break;
        if (resource.activePromptId === promptId) resource.activePromptId = null;
        for (const [binding, bound] of resource.agentTurns) {
          if (bound === promptId) resource.agentTurns.delete(binding);
        }
        break;
      }
      case 'subagent.spawned':
        if (typeof payload.subagentId === 'string') resource.childAgents.add(payload.subagentId);
        break;
      case 'agent.status.updated':
        if (payload.status === 'awaiting_approval') void this.pollPending(resource, 'approvals');
        if (payload.status === 'awaiting_question') void this.pollPending(resource, 'questions');
        break;
      default:
        break;
    }
  }

  private async pollPending(
    resource: SessionResource,
    list: 'approvals' | 'questions',
  ): Promise<void> {
    if (resource.pollInFlight) return;
    resource.pollInFlight = list;
    const kind: PendingInteraction['kind'] = list === 'approvals' ? 'approval' : 'question';
    try {
      const handle = this.input.servers.get(resource.profileKey);
      if (!handle) return;
      const data = await handle.client.get(`/api/v1/sessions/${resource.threadId}/${list}`);
      const items =
        list === 'approvals'
          ? decodeApprovalItems(data).map((item) => ({ kimiId: item.approval_id, item }))
          : decodeQuestionItems(data).map((item) => ({ kimiId: item.question_id, item }));
      for (const { kimiId, item } of items) {
        const known = [...resource.pendingInteractions.values()].some(
          (pending) => pending.kimiId === kimiId,
        );
        if (known) continue;
        const request =
          list === 'approvals'
            ? approvalToServerRequest(++resource.interactionSequence, item as never)
            : questionToServerRequest(++resource.interactionSequence, item as KimiQuestionItem);
        if (!request) continue;
        resource.pendingInteractions.set(String(request.id), { kind, kimiId, settling: false });
        const accepted = await this.input.onServerRequest(resource.sessionId, request, {
          kind: 'root',
        });
        if (!accepted) resource.pendingInteractions.delete(String(request.id));
      }
    } catch {
      // Polling is opportunistic; the next status change retries.
    } finally {
      resource.pollInFlight = null;
    }
  }

  private async resolveInteraction(
    resource: SessionResource,
    requestId: string,
    pending: PendingInteraction & { settling?: boolean },
    result: unknown,
  ): Promise<void> {
    pending.settling = true;
    const handle = this.input.servers.get(resource.profileKey);
    if (!handle) return;
    if (pending.kind === 'approval') {
      const decision = kimiApprovalDecision(result);
      if (!decision) return;
      await handle.client.post(
        `/api/v1/sessions/${resource.threadId}/approvals/${pending.kimiId}`,
        { decision },
      );
      return;
    }
    const data = await handle.client.get(`/api/v1/sessions/${resource.threadId}/questions`);
    const item = decodeQuestionItems(data).find(
      (candidate) => candidate.question_id === pending.kimiId,
    );
    const answers = item ? kimiQuestionAnswers(item, result) : null;
    if (!answers) return;
    try {
      await handle.client.post(
        `/api/v1/sessions/${resource.threadId}/questions/${pending.kimiId}`,
        { answers },
      );
    } catch (error) {
      // A dismissal reports 40909 as its success code; treat it as resolved.
      if (!(isKimiWebError(error) && error.code === 40909)) throw error;
    }
  }

  private requireResource(session: RelaySessionSnapshot): SessionResource {
    const resource = this.sessions.get(session.id);
    if (!resource || !session.threadId) throw new Error(KIMI_SESSION_NOT_RUNNING);
    return resource;
  }

  private async submitPrompt(
    resource: SessionResource,
    promptId: string,
    text: string,
    model: string | undefined,
  ): Promise<void> {
    const handle = this.input.servers.get(resource.profileKey);
    if (!handle) throw new Error(KIMI_SESSION_NOT_RUNNING);
    await handle.client.post(`/api/v1/sessions/${resource.threadId}/prompts`, {
      content: [{ type: 'text', text }],
      prompt_id: promptId,
      ...(model ? { model } : {}),
    });
    resource.pendingPrompts.push(promptId);
    // kimi enqueues prompts submitted while a turn runs; steer pulls the
    // queued prompt into the active turn instead of deferring it.
    if (resource.activePromptId) {
      await handle.client.post(`/api/v1/sessions/${resource.threadId}/prompts:steer`, {
        prompt_ids: [promptId],
      });
    }
  }

  private async readHistoryFrom(resource: SessionResource): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    const handle = this.input.servers.get(resource.profileKey);
    if (!handle) throw new Error(KIMI_SESSION_NOT_RUNNING);
    return this.fetchHistory(handle, resource.threadId);
  }

  private async readDetachedHistory(session: RelaySessionSnapshot): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    const handle = await this.ensureServer(session);
    return this.fetchHistory(handle, session.threadId as string);
  }

  private async fetchHistory(
    handle: KimiServerHandle,
    threadId: string,
  ): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    const [messages, status] = await Promise.all([
      handle.client.get(`/api/v1/sessions/${threadId}/messages`) as Promise<unknown>,
      handle.client.get(`/api/v1/sessions/${threadId}`) as Promise<unknown>,
    ]);
    const items = Array.isArray((messages as { items?: unknown })?.items)
      ? ((messages as { items: unknown[] }).items as Array<Record<string, unknown>>)
      : [];
    return {
      turns: groupMessagesIntoTurns(items),
      activeTurnId: extractActivePromptId(status),
    };
  }

  private async detach(sessionId: string): Promise<void> {
    const resource = this.sessions.get(sessionId);
    if (!resource) return;
    this.sessions.delete(sessionId);
    const connection = this.connections.get(resource.profileKey);
    if (connection) {
      connection.sessions.delete(sessionId);
      if (connection.sessions.size === 0) {
        this.connections.delete(resource.profileKey);
        connection.eventUnsub();
        connection.closeUnsub();
        connection.client.close();
      } else {
        void connection.client.unsubscribe([resource.threadId]).catch(() => {});
      }
    }
  }
}

function kimiPermissionMode(session: RelaySessionSnapshot): 'manual' | 'yolo' | 'auto' {
  const policy = session.executionPolicy?.approvalPolicy;
  if (policy === 'never') return 'yolo';
  return 'manual';
}

function classifyWriterAcquisitionFailure(error: unknown): Error {
  if (error instanceof WriterAcquisitionError) return error;
  if (isKimiWebError(error)) return new WriterAcquisitionError('runtimeUnavailable');
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|spawn|kimi web exited/i.test(message)) {
    return new WriterAcquisitionError('runtimeDependencyFailed');
  }
  return new WriterAcquisitionError('runtimeUnavailable');
}

function isKimiSessionMissing(error: unknown): boolean {
  return isKimiWebError(error) && (error.code === 40401 || error.code === 404);
}

function extractActivePromptId(status: unknown): string | null {
  const record = status && typeof status === 'object' ? (status as Record<string, unknown>) : null;
  if (!record || record.main_turn_active !== true) return null;
  return typeof record.current_prompt_id === 'string' ? record.current_prompt_id : null;
}

/** Groups a kimi transcript into relay turns: each user message opens a turn. */
function groupMessagesIntoTurns(items: Array<Record<string, unknown>>): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;
  for (const message of items.slice(0, 2_000)) {
    const role = typeof message.role === 'string' ? message.role : null;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .flatMap((part) =>
        part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
          ? [String((part as Record<string, unknown>).text ?? '')]
          : [],
      )
      .join('')
      .slice(0, 64_000);
    const id = typeof message.id === 'string' ? message.id : `kimi-message-${turns.length}`;
    if (role === 'user') {
      current = { items: [], startedAt: null, completedAt: null };
      turns.push(current);
      if (text) current.items.push({ id, kind: 'user', text });
      continue;
    }
    if (!current) {
      current = { items: [], startedAt: null, completedAt: null };
      turns.push(current);
    }
    if (role === 'assistant' && text) {
      current.items.push({ id, kind: 'agent', text, phase: 'final_answer' });
    } else if (role === 'tool') {
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'tool_use'
        ) {
          const tool = part as Record<string, unknown>;
          current.items.push({
            id: typeof tool.tool_call_id === 'string' ? tool.tool_call_id : id,
            kind: 'tool',
            name: typeof tool.tool_name === 'string' ? tool.tool_name : 'tool',
            status: 'completed',
          });
        }
      }
    }
  }
  return turns;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTurnNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function agentIdOf(payload: unknown): string | null {
  const value = record(payload);
  return value && typeof value.agentId === 'string' ? value.agentId : null;
}

function turnNumberOf(payload: unknown): number | null {
  const value = record(payload);
  return value ? safeTurnNumber(value.turnId) : null;
}
