/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';
import { randomUUID } from 'node:crypto';
import {
  createPlanMeasurementSnapshot,
  type RateLimitWindow,
  type ThreadTokenBreakdown,
} from '../../features/plans/application/measurement-snapshot.js';
import type { HistoryTurn } from '../../features/sessions/get-history/history-mapper.js';
import type { PlanStatusLease, PlanStatusSource } from '../../features/plans/application/ports.js';
import {
  canRebindMissingRollout,
  rebindMissingRollout,
  type MissingRolloutRecovery,
} from '../../features/sessions/restore-session/use-case.js';
import { gestaltQuizDynamicTool } from '../../../shared/contracts/quiz.js';
import { gestaltOrgPlanAttentionDynamicTool } from '../../../shared/contracts/org-plan-attention.js';
import { gestaltOrgPlanCheckpointDynamicTool } from '../../../shared/contracts/org-plan-checkpoint.js';
import { countDiffLines } from '../../../shared/contracts/file-change.js';
import { threadPlanName } from './thread-plan-name.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import {
  WriterAcquisitionError,
  type WriterAcquisition,
} from '../../features/sessions/application/writer-acquisition.js';
import { isCodexThreadWriterBusy, isMissingCodexThreadRollout } from './json-rpc-client.js';
import { resolvedServerRequestId } from './server-request.js';

export type AppServer = {
  rpc: {
    request(method: string, params: unknown): Promise<unknown>;
    onNotification(
      listener: (notification: { method: string; params: unknown }) => void,
    ): () => void;
    onServerRequest(
      listener: (request: { id: number; method: string; params: unknown }) => Promise<unknown>,
    ): () => void;
  };
  close(): void;
  onExit?(listener: () => void): () => void;
};

export type AppServerLaunchInput = {
  profile: string;
  cwd: string;
  skillsConfig?: readonly { path: string; enabled: boolean }[];
  environment?: Readonly<Record<string, string>>;
};

export type RestoreSessionResult =
  | { session: RelaySessionSnapshot; historyUnavailable: false; replacementCreated: false }
  | MissingRolloutRecovery;

type PendingRequest = {
  resolve(result: unknown): void;
  reject(reason: Error): void;
};

export type DirectChildThread = Readonly<{
  id: string;
  status?: string;
  /** `thread/list` omitted or changed its documented status shape. */
  qualified?: boolean;
  nickname?: string;
  role?: string;
  model?: string;
  taskPath?: string;
}>;

/** Bounded provenance supplied before shared notifications lose thread context. */
export type NotificationOrigin = Readonly<{
  kind: 'root' | 'child' | 'unknown';
  physicalTurnId?: string;
  physicalThreadId?: string;
}>;

export type OwnedChildProcess = Readonly<{
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

/** One private owner for every resource acquired for a live Codex child. */
class SessionResource {
  private disposed = false;
  private explicitShutdown = false;
  readonly pendingRequests = new Map<string, PendingRequest>();
  threadId: string | undefined;
  pendingThreadName: string | undefined;
  writtenThreadName: string | undefined;
  readonly capabilities = new Map<string, boolean>();
  readonly spawnedAgentModels = new Map<string, string>();
  readonly attemptedAgentModelRecovery = new Set<string>();
  readonly ownedChildProcesses = new Map<string, OwnedChildProcess>();
  readonly turnThreads = new Map<string, string>();
  readonly childThreads = new Set<string>();

  constructor(
    readonly sessionId: string,
    readonly process: AppServer,
    readonly planStatusLease: PlanStatusLease | undefined,
    readonly planMeasurementToken: string,
    private unregister: readonly (() => void)[],
    private readonly onDisposed: () => void,
  ) {}

  dispose(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('CODEX_SERVER_REQUEST_CANCELLED'));
    }
    this.pendingRequests.clear();
    for (const unsubscribe of this.unregister) unsubscribe();
    this.process.close();
    this.planStatusLease?.close();
    this.onDisposed();
    return true;
  }

  beginExplicitShutdown(): void {
    this.explicitShutdown = true;
  }

  get exitedUnexpectedly(): boolean {
    return !this.explicitShutdown;
  }

  get active(): boolean {
    return !this.disposed;
  }
  attach(unregister: readonly (() => void)[]): void {
    this.unregister = unregister;
  }
}

export class CodexSessionRuntime {
  constructor(
    private readonly launch: (input: AppServerLaunchInput) => AppServer,
    // Kept as an ignored compatibility slot while callers migrate from the old
    // correlated-map constructor shape.  Live ownership is `sessions` only.
    _legacyProcesses: Map<string, AppServer> | undefined = undefined,
    private readonly onNotification?: (
      sessionId: string,
      notification: { method: string; params: unknown },
      origin: NotificationOrigin,
    ) => void,
    private readonly onServerRequest?: (
      sessionId: string,
      request: { id: number; method: string; params: unknown },
      origin: NotificationOrigin,
    ) => boolean,
    private readonly onProcessExit?: (sessionId: string) => void,
    private readonly resolveSkills?: (
      session: RelaySessionSnapshot,
    ) => Promise<readonly { path: string; enabled: boolean }[] | undefined>,
    private readonly planStatusSource?: PlanStatusSource,
    private readonly onPlanStatus?: (
      sessionId: string,
      update: import('../../features/plans/application/ports.js').PlanStatusUpdate,
    ) => void,
    private readonly planMeasurementBaseUrl?: string,
    // Compatibility slot: blocking app-server requests wait for explicit input.
    _legacyRequestTimeoutMs: number | undefined = undefined,
    private readonly maxPendingRequests = 64,
    private readonly readerCwd?: string,
  ) {
    void _legacyProcesses;
    void _legacyRequestTimeoutMs;
  }
  private readonly sessions = new Map<string, SessionResource>();
  private readonly historyReads = new Map<
    string,
    Promise<{ turns: HistoryTurn[]; activeTurnId: string | null }>
  >();
  private readonly writerAcquisitions = new Map<string, Promise<WriterAcquisition>>();

  async start(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    const resource = await this.createResource(session);
    try {
      await resource.process.rpc.request('initialize', {
        clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      const startedThreadId = await this.startThread(resource.process, session);
      resource.threadId = startedThreadId;
      this.sessions.set(session.id, resource);
      await this.writePendingThreadName(session.id);
      return RelaySession.rehydrate(session)
        .bindThread(startedThreadId, now)
        .supportsAttentionTool(now).snapshot;
    } catch (error) {
      resource.dispose();
      throw error;
    }
  }

  stop(sessionId: string): void {
    const resource = this.sessions.get(sessionId);
    resource?.beginExplicitShutdown();
    resource?.dispose();
  }

  async release(sessionId: string): Promise<void> {
    const resource = this.sessions.get(sessionId);
    // Mark intent before the await below: a process-exit callback can race the
    // unsubscribe response, but it must not turn an explicit close into recovery.
    resource?.beginExplicitShutdown();
    if (resource?.threadId) {
      try {
        await resource.process.rpc.request('thread/unsubscribe', { threadId: resource.threadId });
      } catch {
        // Closing the child still releases relay ownership if Codex has already exited.
      }
    }
    this.stop(sessionId);
  }

  /** Releases all relay-owned app-server children during graceful shutdown. */
  stopAll(): void {
    // Exit delivery can already be queued when shutdown begins. Declare the
    // shared intent for every owner before closing any process.
    const resources = [...this.sessions.values()];
    for (const resource of resources) resource.beginExplicitShutdown();
    for (const resource of resources) resource.dispose();
  }

  /** Keeps a detached session's supervised-plan status observable without launching Codex. */
  async watchPlanStatus(session: RelaySessionSnapshot): Promise<void> {
    if (!this.planStatusSource) return;
    await this.planStatusSource.open(
      { id: session.id, workspacePath: session.workspacePath },
      (update) => this.onPlanStatus?.(session.id, update),
    );
  }

  resolveServerRequest(sessionId: string, requestId: string, result: unknown): boolean {
    const resource = this.sessions.get(sessionId);
    const pending = resource?.pendingRequests.get(requestId);
    if (!resource || !pending) return false;
    resource.pendingRequests.delete(requestId);
    pending.resolve(result);
    return true;
  }

  /** Distinguishes an offline relay writer from a live writer that cleared a request. */
  attentionWriterState(
    sessionId: string,
    requestId: string,
  ): 'available' | 'cleared' | 'unavailable' {
    const resource = this.sessions.get(sessionId);
    if (!resource || !resource.active) return 'unavailable';
    return resource.pendingRequests.has(requestId) ? 'available' : 'cleared';
  }

  async startTurn(
    session: RelaySessionSnapshot,
    text: string,
    clientUserMessageId: string | undefined,
    now: string,
  ): Promise<RelaySessionSnapshot> {
    const resource = this.sessions.get(session.id);
    if (!resource || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const result = decodeTurnStart(
      await resource.process.rpc.request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        ...(session.model ? { model: session.model } : {}),
      }),
    );
    return RelaySession.rehydrate(session).startTurn(result, now).snapshot;
  }

  async startExecutorTurn(
    session: RelaySessionSnapshot,
    childThreadId: string,
    text: string,
    clientUserMessageId: string,
  ): Promise<string> {
    const resource = this.sessions.get(session.id);
    if (!resource) throw new Error('CODEX_SESSION_NOT_RUNNING');
    return decodeTurnStart(
      await resource.process.rpc.request('turn/start', {
        threadId: childThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        clientUserMessageId,
        ...(session.model ? { model: session.model } : {}),
      }),
    );
  }

  /** The sole authoritative in-process ownership probe.  It never launches a child. */
  ownsWriter(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active === true;
  }

  async ensureWriter(session: RelaySessionSnapshot, now: string): Promise<WriterAcquisition> {
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

  async interruptTurn(session: RelaySessionSnapshot, turnId: string): Promise<void> {
    const resource = this.sessions.get(session.id);
    if (!resource || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    await resource.process.rpc.request('turn/interrupt', { threadId: session.threadId, turnId });
  }

  async queueTurnInput(
    session: RelaySessionSnapshot,
    turnId: string,
    text: string,
    clientUserMessageId?: string,
  ): Promise<void> {
    const resource = this.sessions.get(session.id);
    if (!resource || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    await resource.process.rpc.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
  }

  async readPlanMeasurement(session: RelaySessionSnapshot) {
    const resource = this.sessions.get(session.id);
    if (!resource || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const [rateLimits, thread] = await Promise.all([
      resource.process.rpc.request('account/rateLimits/read', {}),
      resource.process.rpc.request('thread/read', {
        threadId: session.threadId,
        includeTurns: true,
      }),
    ]);
    return createPlanMeasurementSnapshot({
      capturedAt: new Date().toISOString(),
      rateLimits: rateLimitWindows(decodeRateLimits(rateLimits)),
      tokenUsage: threadTokenUsage(thread),
    });
  }

  authorizePlanMeasurement(sessionId: string, authorization: string | undefined): boolean {
    const token = this.sessions.get(sessionId)?.planMeasurementToken;
    return Boolean(token && authorization === `Bearer ${token}`);
  }

  async readHistory(session: RelaySessionSnapshot): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    if (!session.threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    const owned = this.sessions.get(session.id);
    if (owned) return this.decodeHistory(owned.process, session.threadId, owned);
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

  /** Bounded reconciliation port for direct spawned children only. */
  async listDirectChildren(session: RelaySessionSnapshot): Promise<readonly DirectChildThread[]> {
    if (!session.threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    const owned = this.sessions.get(session.id);
    if (!owned) return [];
    const children: DirectChildThread[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4 && children.length < 64; page += 1) {
      const result = await owned.process.rpc.request('thread/list', {
        parentThreadId: session.threadId,
        ...(cursor ? { cursor } : {}),
      });
      const response =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
      const data = response && Array.isArray(response.data) ? response.data : [];
      children.push(
        ...data.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const value = candidate as Record<string, unknown>;
          if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256)
            return [];
          const rawStatus =
            value.status && typeof value.status === 'object'
              ? (value.status as Record<string, unknown>).type
              : undefined;
          // `thread/list` is our bounded child-authority read. A row without
          // one of its documented statuses cannot prove a child is healthy.
          const status =
            rawStatus === 'active' ||
            rawStatus === 'idle' ||
            rawStatus === 'notLoaded' ||
            rawStatus === 'systemError'
              ? rawStatus
              : undefined;
          return [
            {
              id: value.id,
              ...(status ? { status } : { status: 'notLoaded', qualified: false }),
              ...(typeof value.agentNickname === 'string' && value.agentNickname.length <= 128
                ? { nickname: value.agentNickname }
                : {}),
              ...(typeof value.agentRole === 'string' && value.agentRole.length <= 128
                ? { role: value.agentRole }
                : {}),
              ...(owned.spawnedAgentModels.get(value.id)
                ? { model: owned.spawnedAgentModels.get(value.id)! }
                : {}),
              ...(decodeAgentTaskPath(value.source)
                ? { taskPath: decodeAgentTaskPath(value.source)! }
                : {}),
            },
          ];
        }),
      );
      const next =
        typeof response?.nextCursor === 'string' && response.nextCursor.length <= 256
          ? response.nextCursor
          : undefined;
      if (!next) return this.withResolvedChildModels(owned, children);
      if (cursors.has(next) || children.length >= 64)
        throw new Error('CODEX_CHILD_LIST_UNSUPPORTED');
      cursors.add(next);
      cursor = next;
    }
    if (cursor) throw new Error('CODEX_CHILD_LIST_UNSUPPORTED');
    return this.withResolvedChildModels(owned, children);
  }

  private async withResolvedChildModels(
    resource: SessionResource,
    children: readonly DirectChildThread[],
  ): Promise<readonly DirectChildThread[]> {
    for (const child of children) {
      if (
        resource.spawnedAgentModels.has(child.id) ||
        resource.attemptedAgentModelRecovery.has(child.id)
      )
        continue;
      // thread/list omits the model for loaded and unloaded subagents alike.
      // A spawn item can also contain null when an agent role selects or
      // inherits the model, so thread/resume is the bounded authoritative read.
      resource.attemptedAgentModelRecovery.add(child.id);
      try {
        const response = await resource.process.rpc.request('thread/resume', {
          threadId: child.id,
        });
        const model = boundedString(asRecord(response)?.model, 256);
        if (model) resource.spawnedAgentModels.set(child.id, model);
      } catch {
        // A live settings notification can still provide the model later.
      }
    }
    return children.map((child) => {
      const model = child.model ?? resource.spawnedAgentModels.get(child.id);
      return model && model !== child.model ? { ...child, model } : child;
    });
  }

  /** Reads only bounded process metadata; command text and output never enter lifecycle state. */
  async inspectChildProcesses(
    session: RelaySessionSnapshot,
    child: Pick<DirectChildThread, 'id' | 'taskPath'>,
  ): Promise<readonly OwnedChildProcess[]> {
    const owned = this.sessions.get(session.id);
    if (!owned) return [];
    const active = await this.listChildBackgroundTerminals(owned, child);
    const activeIds = new Set(active.map((process) => process.processId));
    for (const process of active)
      owned.ownedChildProcesses.set(childProcessKey(child.id, process.processId), process);

    const prior = [...owned.ownedChildProcesses.values()].filter(
      (process) => process.ownerThreadId === child.id && !activeIds.has(process.processId),
    );
    if (
      prior.some((process) => process.state === 'running' || process.state === 'detached-active')
    ) {
      const results = await this.readChildProcessResults(owned, child.id);
      for (const process of prior) {
        if (process.state !== 'running' && process.state !== 'detached-active') continue;
        const result = results.get(process.itemId);
        owned.ownedChildProcesses.set(childProcessKey(child.id, process.processId), {
          ...process,
          state: 'exited-awaiting-result',
          cpuPercent: 0,
          rssBytes: 0,
          ...(result?.exitStatus === undefined ? {} : { exitStatus: result.exitStatus }),
          resultArtifact: `${child.id}:${process.itemId}`,
        });
      }
    }
    return [...owned.ownedChildProcesses.values()].filter(
      (process) =>
        process.ownerThreadId === child.id &&
        process.state !== 'result-consumed' &&
        process.state !== 'terminated-for-budget',
    );
  }

  consumeChildProcessResult(sessionId: string, childThreadId: string, processId: string): void {
    this.sessions
      .get(sessionId)
      ?.ownedChildProcesses.delete(childProcessKey(childThreadId, processId));
  }

  async terminateChildProcess(
    session: RelaySessionSnapshot,
    childThreadId: string,
    processId: string,
  ): Promise<boolean> {
    const owned = this.sessions.get(session.id);
    if (!owned) return false;
    const result = await owned.process.rpc.request('thread/backgroundTerminals/terminate', {
      threadId: childThreadId,
      processId,
    });
    const terminated = asRecord(result)?.terminated === true;
    if (terminated) {
      const key = childProcessKey(childThreadId, processId);
      const process = owned.ownedChildProcesses.get(key);
      if (process)
        owned.ownedChildProcesses.set(key, { ...process, state: 'terminated-for-budget' });
    }
    return terminated;
  }

  private async listChildBackgroundTerminals(
    owned: SessionResource,
    child: Pick<DirectChildThread, 'id' | 'taskPath'>,
  ): Promise<readonly OwnedChildProcess[]> {
    const processes: OwnedChildProcess[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4 && processes.length < 64; page += 1) {
      const result = await owned.process.rpc.request('thread/backgroundTerminals/list', {
        threadId: child.id,
        limit: 64,
        ...(cursor ? { cursor } : {}),
      });
      const response = asRecord(result);
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const candidate of data) {
        const value = asRecord(candidate);
        const itemId = boundedString(value?.itemId, 256);
        const processId = boundedString(value?.processId, 256);
        if (!itemId || !processId || processes.length >= 64) continue;
        const key = childProcessKey(child.id, processId);
        const before = owned.ownedChildProcesses.get(key);
        const observedAt = before?.observedAt ?? new Date().toISOString();
        const rssKb = boundedNonNegativeNumber(value?.rssKb);
        processes.push({
          processId,
          itemId,
          ownerThreadId: child.id,
          ownerTaskPath: child.taskPath ?? child.id,
          ownership: before?.ownership ?? 'executor',
          state: before?.state === 'detached-active' ? 'detached-active' : 'running',
          observedAt,
          elapsedMs: Math.max(0, Date.now() - Date.parse(observedAt)),
          cpuPercent: boundedNonNegativeNumber(value?.cpuPercent),
          rssBytes: rssKb === null ? null : Math.min(Number.MAX_SAFE_INTEGER, rssKb * 1024),
          ...(boundedNonNegativeInteger(value?.osPid) === null
            ? {}
            : { osPid: boundedNonNegativeInteger(value?.osPid)! }),
        });
      }
      const next = boundedString(response?.nextCursor, 256);
      if (!next) return processes;
      if (cursors.has(next) || processes.length >= 64)
        throw new Error('CODEX_BACKGROUND_TERMINAL_LIST_UNSUPPORTED');
      cursors.add(next);
      cursor = next;
    }
    if (cursor) throw new Error('CODEX_BACKGROUND_TERMINAL_LIST_UNSUPPORTED');
    return processes;
  }

  private async readChildProcessResults(
    owned: SessionResource,
    childThreadId: string,
  ): Promise<ReadonlyMap<string, Readonly<{ exitStatus?: number }>>> {
    const result = await owned.process.rpc.request('thread/read', {
      threadId: childThreadId,
      includeTurns: true,
    });
    const decoded = new Map<string, Readonly<{ exitStatus?: number }>>();
    const turns = asRecord(asRecord(result)?.thread)?.turns;
    if (!Array.isArray(turns) || turns.length > 10_000) return decoded;
    for (const turn of turns) {
      const items = asRecord(turn)?.items;
      if (!Array.isArray(items) || items.length > 10_000) continue;
      for (const candidate of items) {
        const item = asRecord(candidate);
        const itemId = boundedString(item?.id, 256);
        if (
          item?.type !== 'commandExecution' ||
          !itemId ||
          !['completed', 'failed', 'declined'].includes(String(item.status))
        )
          continue;
        const exitStatus = boundedInteger(item.exitCode);
        decoded.set(itemId, exitStatus === null ? {} : { exitStatus });
      }
    }
    return decoded;
  }

  private async readDetachedHistory(session: RelaySessionSnapshot): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    // A reader is intentionally not a SessionResource: it owns no subscriptions,
    // runtime registration, plan lease, or writer state and is closed on every path.
    const process = this.launch({
      profile: session.profile,
      cwd: this.readerCwd ?? session.workspacePath,
    });
    try {
      await process.rpc.request('initialize', {
        clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      return await this.decodeHistory(process, session.threadId!);
    } finally {
      process.close();
    }
  }

  private async decodeHistory(
    process: AppServer,
    threadId: string,
    resource?: SessionResource,
  ): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    const response = await process.rpc.request('thread/read', { threadId, includeTurns: true });
    if (resource) {
      for (const [childId, model] of decodeSpawnedAgentModels(response))
        resource.spawnedAgentModels.set(childId, model);
    }
    const result = decodeThreadRead(response);
    const rawTurns = result;
    const activeTurn = rawTurns.find(
      (turn) => turn.status === 'inProgress' && typeof turn.id === 'string',
    );
    return {
      turns: rawTurns.map((turn) => ({
        ...(typeof turn.id === 'string' ? { id: turn.id } : {}),
        items: turn.items ?? [],
        startedAt: typeof turn.startedAt === 'number' ? turn.startedAt : null,
        completedAt: typeof turn.completedAt === 'number' ? turn.completedAt : null,
      })),
      activeTurnId: typeof activeTurn?.id === 'string' ? activeTurn.id : null,
    };
  }

  async restore(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    return (await this.restoreWithOutcome(session, now)).session;
  }

  async restoreWithOutcome(
    session: RelaySessionSnapshot,
    now: string,
  ): Promise<RestoreSessionResult> {
    if (!session.threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    const resource = await this.createResource(session);
    try {
      await resource.process.rpc.request('initialize', {
        clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      let result: RestoreSessionResult;
      try {
        await resource.process.rpc.request('thread/resume', {
          threadId: session.threadId,
          cwd: session.workspacePath,
          ...(session.executionPolicy?.approvalPolicy
            ? { approvalPolicy: session.executionPolicy.approvalPolicy }
            : {}),
          ...(session.executionPolicy?.sandbox ? { sandbox: session.executionPolicy.sandbox } : {}),
          dynamicTools: [
            gestaltQuizDynamicTool,
            gestaltOrgPlanAttentionDynamicTool,
            gestaltOrgPlanCheckpointDynamicTool,
          ],
        });
        result = {
          session: RelaySession.rehydrate(session).restore(now).supportsAttentionTool(now).snapshot,
          historyUnavailable: false,
          replacementCreated: false,
        };
      } catch (error) {
        if (!canRebindMissingRollout(session, error)) throw error;
        const replacementThreadId = await this.startThread(resource.process, session);
        result = rebindMissingRollout(session, error, replacementThreadId, now);
      }
      resource.threadId = result.session.threadId!;
      this.sessions.get(session.id)?.dispose();
      this.sessions.set(session.id, resource);
      await this.writePendingThreadName(session.id);
      return result;
    } catch (error) {
      resource.dispose();
      throw error;
    }
  }

  /** Best-effort metadata only: failures never affect plan or session execution. */
  async syncThreadPlanName(sessionId: string, plan: SupervisedPlan): Promise<void> {
    const resource = this.sessions.get(sessionId);
    if (!resource) return;
    resource.pendingThreadName = threadPlanName(plan);
    await this.writePendingThreadName(sessionId);
  }

  private async writePendingThreadName(sessionId: string): Promise<void> {
    const resource = this.sessions.get(sessionId);
    const threadId = resource?.threadId;
    const name = resource?.pendingThreadName;
    if (
      !resource ||
      !threadId ||
      !name ||
      resource.writtenThreadName === name ||
      resource.capabilities.get('thread/name/set') === false
    )
      return;
    try {
      await resource.process.rpc.request('thread/name/set', { threadId, name });
      if (resource.active) {
        resource.capabilities.set('thread/name/set', true);
        resource.writtenThreadName = name;
      }
    } catch (error) {
      if (isMethodNotFound(error)) resource.capabilities.set('thread/name/set', false);
      // Unsupported servers and transient failures are bounded metadata failures.
    }
  }

  private holdServerRequest(
    resource: SessionResource,
    request: { id: number; method: string; params: unknown },
  ): Promise<unknown> {
    if (!resource.active) return Promise.reject(new Error('CODEX_SERVER_REQUEST_CANCELLED'));
    if (resource.pendingRequests.size >= this.maxPendingRequests)
      return Promise.reject(new Error('CODEX_SERVER_REQUEST_LIMIT'));
    const requestId = String(request.id);
    if (resource.pendingRequests.has(requestId))
      return Promise.reject(new Error('CODEX_SERVER_REQUEST_DUPLICATE'));
    return new Promise((resolve, reject) => {
      resource.pendingRequests.set(requestId, { resolve, reject });
      let accepted = false;
      try {
        accepted =
          this.onServerRequest?.(
            resource.sessionId,
            request,
            this.resolveNotificationOrigin(resource, request),
          ) === true;
      } catch {
        // Publication failures are protocol failures, not permission to retain
        // an unreachable app-server request.
      }
      if (!accepted && resource.pendingRequests.delete(requestId))
        reject(new Error('CODEX_SERVER_REQUEST_UNSUPPORTED'));
    });
  }

  private async startThread(process: AppServer, session: RelaySessionSnapshot): Promise<string> {
    return decodeThreadStart(
      await process.rpc.request('thread/start', this.threadStartParams(session)),
    );
  }

  private threadStartParams(session: RelaySessionSnapshot): Record<string, unknown> {
    return {
      cwd: session.workspacePath,
      approvalPolicy: session.executionPolicy?.approvalPolicy ?? 'on-request',
      dynamicTools: [
        gestaltQuizDynamicTool,
        gestaltOrgPlanAttentionDynamicTool,
        gestaltOrgPlanCheckpointDynamicTool,
      ],
      ...(session.model ? { model: session.model } : {}),
      ...(session.executionPolicy?.sandbox ? { sandbox: session.executionPolicy.sandbox } : {}),
    };
  }

  private async createResource(session: RelaySessionSnapshot): Promise<SessionResource> {
    const lease = this.planStatusSource
      ? await this.planStatusSource.open(
          { id: session.id, workspacePath: session.workspacePath },
          (update) => this.onPlanStatus?.(session.id, update),
        )
      : undefined;
    try {
      const token = randomUUID();
      const process = this.launch({
        profile: session.profile,
        cwd: session.workspacePath,
        skillsConfig: await this.resolveSkills?.(session),
        ...(lease || this.planMeasurementBaseUrl
          ? {
              environment: {
                ...(lease
                  ? { GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: lease.statusDirectory }
                  : {}),
                ...(this.planMeasurementBaseUrl
                  ? {
                      GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL: `${this.planMeasurementBaseUrl}/api/sessions/${session.id}/plan-measurement`,
                      GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN: token,
                    }
                  : {}),
              },
            }
          : {}),
      });
      const resource = new SessionResource(session.id, process, lease, token, [], () => {
        if (this.sessions.get(session.id) === resource) this.sessions.delete(session.id);
      });
      // Own process exit before resume/initialization can make this resource appear healthy.
      // A short-lived child could otherwise leave a durable ready session without a writer.
      const exitUnsubscribe =
        process.onExit?.(() => {
          if (resource.dispose() && resource.exitedUnexpectedly) this.onProcessExit?.(session.id);
        }) ?? (() => {});
      resource.attach([exitUnsubscribe]);
      if (!resource.active) {
        exitUnsubscribe();
        throw new Error('CODEX_SESSION_PROCESS_EXITED');
      }
      const notificationUnsubscribe = process.rpc.onNotification((notification) => {
        if (!resource.active) return;
        const childModel = decodeThreadSettingsModel(notification);
        if (
          childModel &&
          (resource.spawnedAgentModels.has(childModel.threadId) ||
            resource.spawnedAgentModels.size < 256)
        )
          resource.spawnedAgentModels.set(childModel.threadId, childModel.model);
        const resolvedRequestId = resolvedServerRequestId(notification);
        if (resolvedRequestId) {
          const pending = resource.pendingRequests.get(resolvedRequestId);
          resource.pendingRequests.delete(resolvedRequestId);
          // App-server has already cleared the request, so settle the local handler too.
          // The late JSON-RPC error response is harmless and prevents an orphaned promise.
          // The notification callback reconciles the durable interaction record.
          pending?.reject(new Error('CODEX_SERVER_REQUEST_CLEARED'));
        }
        this.onNotification?.(
          session.id,
          notification,
          this.resolveNotificationOrigin(resource, notification),
        );
      });
      const requestUnsubscribe = process.rpc.onServerRequest((request) =>
        this.holdServerRequest(resource, request),
      );
      if (!resource.active) {
        notificationUnsubscribe();
        requestUnsubscribe();
        throw new Error('CODEX_SESSION_PROCESS_EXITED');
      }
      // The resource's private unsubscribe list is populated before it is published.
      resource.attach([notificationUnsubscribe, requestUnsubscribe, exitUnsubscribe]);
      return resource;
    } catch (error) {
      lease?.close();
      throw error;
    }
  }

  private resolveNotificationOrigin(
    resource: SessionResource,
    notification: { method: string; params: unknown },
  ): NotificationOrigin {
    const params = asRecord(notification.params);
    if (!params) return { kind: 'unknown' };
    const item = asRecord(params.item);
    if (item?.type === 'collabAgentToolCall' || item?.type === 'collabToolCall') {
      for (const value of [item.receiverThreadId, item.newThreadId])
        if (boundedString(value, 256) && resource.childThreads.size < 64)
          resource.childThreads.add(boundedString(value, 256)!);
      if (Array.isArray(item.receiverThreadIds))
        for (const value of item.receiverThreadIds)
          if (boundedString(value, 256) && resource.childThreads.size < 64)
            resource.childThreads.add(boundedString(value, 256)!);
      const states = asRecord(item.agentsStates);
      if (states)
        for (const childId of Object.keys(states))
          if (boundedString(childId, 256) && resource.childThreads.size < 64)
            resource.childThreads.add(childId);
    }
    const turn = asRecord(params.turn);
    const turnId =
      boundedString(params.turnId, 256) ??
      boundedString(turn?.id, 256) ??
      boundedString(item?.turnId, 256);
    if (notification.method === 'turn/started' && turnId && boundedString(params.threadId, 256)) {
      if (resource.turnThreads.has(turnId) || resource.turnThreads.size < 256)
        resource.turnThreads.set(turnId, boundedString(params.threadId, 256)!);
    }
    const resolvedThreadId =
      boundedString(params.threadId, 256) ??
      (turnId ? resource.turnThreads.get(turnId) : undefined);
    const origin: NotificationOrigin = {
      kind:
        resolvedThreadId && resolvedThreadId === resource.threadId
          ? 'root'
          : resolvedThreadId && resource.childThreads.has(resolvedThreadId)
            ? 'child'
            : 'unknown',
      ...(turnId ? { physicalTurnId: turnId } : {}),
      ...(resolvedThreadId ? { physicalThreadId: resolvedThreadId } : {}),
    };
    if (notification.method === 'turn/completed' && turnId) resource.turnThreads.delete(turnId);
    return origin;
  }
}

function isMethodNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === -32601,
  );
}

function classifyWriterAcquisitionFailure(error: unknown): WriterAcquisitionError {
  if (isCodexThreadWriterBusy(error)) return new WriterAcquisitionError('writerBusy');
  if (isMissingCodexThreadRollout(error)) return new WriterAcquisitionError('rolloutMissing');
  if (isMethodNotFound(error)) return new WriterAcquisitionError('protocolIncompatible');
  const code = error instanceof Error ? error.message : '';
  if (code === 'ENOENT' || code === 'CODEX_THREAD_ID_MISSING')
    return new WriterAcquisitionError('workspaceUnavailable');
  if (/MCP|DEPENDENCY|SKILL/i.test(code))
    return new WriterAcquisitionError('runtimeDependencyFailed');
  return new WriterAcquisitionError('runtimeUnavailable');
}

function rateLimitWindows(value: unknown): readonly RateLimitWindow[] | undefined {
  const limits = asRecord(value)?.rateLimits;
  if (!Array.isArray(limits)) return undefined;
  return limits.flatMap((limit) => {
    const record = asRecord(limit);
    const durationMinutes = record?.windowDurationMins;
    const usedPercent = record?.usedPercent;
    return typeof durationMinutes === 'number' && typeof usedPercent === 'number'
      ? [{ durationSeconds: durationMinutes * 60, usedPercent }]
      : [];
  });
}
function decodeRateLimits(
  value: unknown,
): { rateLimits: Array<{ windowDurationMins: number; usedPercent: number }> } | undefined {
  const limits = asRecord(value)?.rateLimits;
  if (!Array.isArray(limits) || limits.length > 32) return undefined;
  const decoded = limits.flatMap((limit) => {
    const record = asRecord(limit);
    return typeof record?.windowDurationMins === 'number' &&
      Number.isFinite(record.windowDurationMins) &&
      typeof record.usedPercent === 'number' &&
      Number.isFinite(record.usedPercent)
      ? [{ windowDurationMins: record.windowDurationMins, usedPercent: record.usedPercent }]
      : [];
  });
  return decoded.length === limits.length ? { rateLimits: decoded } : undefined;
}

function threadTokenUsage(value: unknown): ThreadTokenBreakdown | undefined {
  const turns = asRecord(asRecord(value)?.thread)?.turns;
  if (!Array.isArray(turns)) return undefined;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const turn of turns) {
    const usage = asRecord(asRecord(turn)?.tokenUsage);
    if (!usage) return undefined;
    const input = usage.inputTokens;
    const cached = usage.cachedInputTokens;
    const output = usage.outputTokens;
    if (typeof input !== 'number' || typeof cached !== 'number' || typeof output !== 'number')
      return undefined;
    inputTokens += input;
    cachedInputTokens += cached;
    outputTokens += output;
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function decodeAgentTaskPath(value: unknown): string | undefined {
  const subagent = asRecord(asRecord(value)?.subagent);
  const spawn = asRecord(subagent?.thread_spawn);
  const path = boundedString(spawn?.agent_path, 256);
  return path?.startsWith('/') && !path.includes('..') ? path : undefined;
}

/** Captures the resolved model that Codex applies after spawning a child thread. */
function decodeThreadSettingsModel(
  notification: Readonly<{ method: string; params: unknown }>,
): { threadId: string; model: string } | undefined {
  if (notification.method !== 'thread/settings/updated') return undefined;
  const params = asRecord(notification.params);
  const threadId = boundedString(params?.threadId, 256);
  const model = boundedString(asRecord(params?.threadSettings)?.model, 256);
  return threadId && model ? { threadId, model } : undefined;
}

function childProcessKey(childThreadId: string, processId: string): string {
  return `${childThreadId}:${processId}`;
}

function boundedNonNegativeNumber(value: unknown): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function boundedNonNegativeInteger(value: unknown): number | null {
  const number = boundedInteger(value);
  return number !== null && number >= 0 ? number : null;
}

function decodeThreadStart(value: unknown): string {
  const id = asRecord(asRecord(value)?.thread)?.id;
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('CODEX_THREAD_ID_MISSING');
  return id;
}
function decodeTurnStart(value: unknown): string {
  const id = asRecord(asRecord(value)?.turn)?.id;
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('CODEX_TURN_ID_MISSING');
  return id;
}
function decodeThreadRead(value: unknown): Array<{
  id?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  items?: Array<Record<string, unknown>>;
}> {
  const turns = asRecord(asRecord(value)?.thread)?.turns;
  if (!Array.isArray(turns) || turns.length > 10_000)
    throw new Error('CODEX_THREAD_READ_MALFORMED');
  return turns.map((turn) => {
    const record = asRecord(turn);
    if (!record) throw new Error('CODEX_THREAD_READ_MALFORMED');
    return {
      id: boundedString(record.id),
      status: boundedString(record.status),
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : undefined,
      completedAt: typeof record.completedAt === 'number' ? record.completedAt : undefined,
      items: Array.isArray(record.items) ? record.items.flatMap(decodeHistoryItem) : undefined,
    };
  });
}
function boundedString(value: unknown, max = 64_000): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}
function decodeHistoryItem(value: unknown): Array<Record<string, unknown>> {
  const item = asRecord(value);
  const id = boundedString(item?.id, 256);
  const type = boundedString(item?.type, 64);
  if (!item || !id || !type) return [];
  if (type === 'userMessage') {
    const content = decodeUserMessageContent(item.content);
    if (!content.length) return [];
    const clientId = boundedString(item.clientId, 256);
    return [{ id, type, content, ...(clientId ? { clientId } : {}) }];
  }
  if (type === 'agentMessage')
    return [
      {
        id,
        type,
        ...(boundedString(item.text) ? { text: boundedString(item.text)! } : {}),
        ...(boundedString(item.phase, 64) ? { phase: boundedString(item.phase, 64)! } : {}),
      },
    ];
  if (type === 'reasoning') {
    const summary = decodeReasoningSummary(item.summary);
    return summary.length ? [{ id, type, summary }] : [];
  }
  if (type === 'plan' && boundedString(item.text))
    return [{ id, type, text: boundedString(item.text)! }];
  if (type === 'commandExecution' && boundedString(item.command) && boundedString(item.status, 64))
    return [
      {
        id,
        type,
        command: boundedString(item.command)!,
        status: boundedString(item.status, 64)!,
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
      },
    ];
  if (type === 'fileChange') {
    const changes = decodeFileChanges(item.changes);
    const status = boundedString(item.status, 64);
    return changes.length && status ? [{ id, type, changes, status }] : [];
  }
  if ((type === 'mcpToolCall' || type === 'dynamicToolCall') && boundedString(item.tool)) {
    const status = boundedString(item.status, 64);
    return status ? [{ id, type, tool: boundedString(item.tool)!, status }] : [];
  }
  return [];
}

/** Recovers optional spawn metadata without exposing collaboration prompts to chat history. */
function decodeSpawnedAgentModels(value: unknown): ReadonlyMap<string, string> {
  const models = new Map<string, string>();
  const turns = asRecord(asRecord(value)?.thread)?.turns;
  if (!Array.isArray(turns) || turns.length > 10_000) return models;
  for (const turn of turns) {
    const items = asRecord(turn)?.items;
    if (!Array.isArray(items) || items.length > 10_000) continue;
    for (const candidate of items) {
      const item = asRecord(candidate);
      const model = boundedString(item?.model, 256);
      if (
        item?.type !== 'collabAgentToolCall' ||
        (item.tool !== 'spawnAgent' && item.tool !== 'spawn_agent') ||
        !model ||
        !Array.isArray(item.receiverThreadIds) ||
        item.receiverThreadIds.length > 64
      )
        continue;
      for (const receiver of item.receiverThreadIds) {
        const childId = boundedString(receiver, 256);
        if (childId) models.set(childId, model);
        if (models.size >= 64) return models;
      }
    }
  }
  return models;
}

function decodeUserMessageContent(value: unknown): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(value) || value.length > 1_000) return [];
  return value.flatMap((part) => {
    const record = asRecord(part);
    const text = boundedString(record?.text);
    return record?.type === 'text' && text ? [{ type: 'text' as const, text }] : [];
  });
}

function decodeReasoningSummary(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) return [];
  return value.flatMap((part) => {
    if (boundedString(part)) return [boundedString(part)!];
    const record = asRecord(part);
    const text = boundedString(record?.text);
    return record?.type === 'summary_text' && text ? [text] : [];
  });
}

function decodeFileChanges(
  value: unknown,
): Array<{ path: string; additions?: number; deletions?: number }> {
  if (!Array.isArray(value) || value.length > 1_000) return [];
  return value.flatMap((change) => {
    const candidate = asRecord(change);
    const path = boundedString(candidate?.path);
    const diff = boundedString(candidate?.diff);
    if (!path) return [];
    if (!diff) return [{ path }];
    return [{ path, ...countDiffLines(diff) }];
  });
}
