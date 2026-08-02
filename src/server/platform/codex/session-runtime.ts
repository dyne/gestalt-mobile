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
import type { StartSessionSettings } from '../../features/sessions/application/start-settings.js';
import type { HistoryTurn } from '../../features/sessions/get-history/history-mapper.js';
import type { PlanStatusLease, PlanStatusSource } from '../../features/plans/application/ports.js';
import {
  canRebindMissingRollout,
  rebindMissingRollout,
  type MissingRolloutRecovery,
} from '../../features/sessions/restore-session/use-case.js';
import { gestaltQuizDynamicTool } from '../../../shared/contracts/quiz.js';

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

export class CodexSessionRuntime {
  constructor(
    private readonly launch: (input: AppServerLaunchInput) => AppServer,
    private readonly processes = new Map<string, AppServer>(),
    private readonly onNotification?: (
      sessionId: string,
      notification: { method: string; params: unknown },
    ) => void,
    private readonly onServerRequest?: (
      sessionId: string,
      request: { id: number; method: string; params: unknown },
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
  ) {}
  private readonly pendingRequests = new Map<string, (result: unknown) => void>();
  private readonly exitUnsubscribers = new Map<string, () => void>();
  private readonly threadIds = new Map<string, string>();
  private readonly planStatusLeases = new Map<string, PlanStatusLease>();
  private readonly planMeasurementTokens = new Map<string, string>();

  async start(
    session: RelaySessionSnapshot,
    now: string,
    settings: StartSessionSettings = {},
  ): Promise<RelaySessionSnapshot> {
    const process = await this.launchForSession(session);
    try {
      process.rpc.onNotification((notification) => this.onNotification?.(session.id, notification));
      process.rpc.onServerRequest((request) => this.holdServerRequest(session.id, request));
      this.attachExitHandler(session.id, process);
      await process.rpc.request('initialize', {
        clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      const startedThreadId = await this.startThread(process, session, settings);
      this.processes.set(session.id, process);
      this.threadIds.set(session.id, startedThreadId);
      return RelaySession.rehydrate(session).bindThread(startedThreadId, now).snapshot;
    } catch (error) {
      this.discardProcess(session.id, process);
      throw error;
    }
  }

  stop(sessionId: string): void {
    this.exitUnsubscribers.get(sessionId)?.();
    this.exitUnsubscribers.delete(sessionId);
    this.processes.get(sessionId)?.close();
    this.processes.delete(sessionId);
    this.threadIds.delete(sessionId);
    this.clearPendingRequests(sessionId);
    this.planMeasurementTokens.delete(sessionId);
    this.releasePlanStatus(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const process = this.processes.get(sessionId);
    const threadId = this.threadIds.get(sessionId);
    if (process && threadId) {
      try {
        await process.rpc.request('thread/unsubscribe', { threadId });
      } catch {
        // Closing the child still releases relay ownership if Codex has already exited.
      }
    }
    this.stop(sessionId);
  }

  /** Releases all relay-owned app-server children during graceful shutdown. */
  stopAll(): void {
    for (const sessionId of [...this.processes.keys()]) this.stop(sessionId);
    for (const sessionId of [...this.planStatusLeases.keys()]) this.releasePlanStatus(sessionId);
  }

  resolveServerRequest(sessionId: string, requestId: string, result: unknown): boolean {
    const key = `${sessionId}:${requestId}`;
    const resolve = this.pendingRequests.get(key);
    if (!resolve) return false;
    this.pendingRequests.delete(key);
    resolve(result);
    return true;
  }

  async startTurn(
    session: RelaySessionSnapshot,
    text: string,
    now: string,
  ): Promise<RelaySessionSnapshot> {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const result = (await process.rpc.request('turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(session.model ? { model: session.model } : {}),
    })) as { turn?: { id?: string } };
    if (!result.turn?.id) throw new Error('CODEX_TURN_ID_MISSING');
    return RelaySession.rehydrate(session).startTurn(result.turn.id, now).snapshot;
  }

  async interruptTurn(session: RelaySessionSnapshot, turnId: string): Promise<void> {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    await process.rpc.request('turn/interrupt', { threadId: session.threadId, turnId });
  }

  async readPlanMeasurement(session: RelaySessionSnapshot) {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const [rateLimits, thread] = await Promise.all([
      process.rpc.request('account/rateLimits/read', {}),
      process.rpc.request('thread/read', { threadId: session.threadId, includeTurns: true }),
    ]);
    return createPlanMeasurementSnapshot({
      capturedAt: new Date().toISOString(),
      rateLimits: rateLimitWindows(rateLimits),
      tokenUsage: threadTokenUsage(thread),
    });
  }

  authorizePlanMeasurement(sessionId: string, authorization: string | undefined): boolean {
    const token = this.planMeasurementTokens.get(sessionId);
    return Boolean(token && authorization === `Bearer ${token}`);
  }

  async readHistory(session: RelaySessionSnapshot): Promise<{
    turns: HistoryTurn[];
    activeTurnId: string | null;
  }> {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const result = (await process.rpc.request('thread/read', {
      threadId: session.threadId,
      includeTurns: true,
    })) as {
      thread?: {
        turns?: Array<{
          id?: unknown;
          status?: unknown;
          startedAt?: unknown;
          completedAt?: unknown;
          items?: Array<Record<string, unknown>>;
        }>;
      };
    };
    const rawTurns = result.thread?.turns ?? [];
    const activeTurn = rawTurns.find(
      (turn) => turn.status === 'inProgress' && typeof turn.id === 'string',
    );
    return {
      turns: rawTurns.map((turn) => ({
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

  async restoreWithOutcome(session: RelaySessionSnapshot, now: string): Promise<RestoreSessionResult> {
    if (!session.threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    const process = await this.launchForSession(session);
    try {
      process.rpc.onNotification((notification) => this.onNotification?.(session.id, notification));
      process.rpc.onServerRequest((request) => this.holdServerRequest(session.id, request));
      this.attachExitHandler(session.id, process);
      await process.rpc.request('initialize', {
        clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      let result: RestoreSessionResult;
      try {
        await process.rpc.request('thread/resume', {
          threadId: session.threadId,
          cwd: session.workspacePath,
          dynamicTools: [gestaltQuizDynamicTool],
        });
        result = {
          session: RelaySession.rehydrate(session).restore(now).snapshot,
          historyUnavailable: false,
          replacementCreated: false,
        };
      } catch (error) {
        if (!canRebindMissingRollout(session, error)) throw error;
        const replacementThreadId = await this.startThread(process, session, { model: session.model });
        result = rebindMissingRollout(session, error, replacementThreadId, now);
      }
      this.processes.set(session.id, process);
      this.threadIds.set(session.id, result.session.threadId!);
      return result;
    } catch (error) {
      this.discardProcess(session.id, process);
      throw error;
    }
  }

  private holdServerRequest(
    sessionId: string,
    request: { id: number; method: string; params: unknown },
  ): Promise<unknown> {
    if (!this.onServerRequest?.(sessionId, request)) {
      return Promise.reject(new Error('CODEX_SERVER_REQUEST_UNSUPPORTED'));
    }
    return new Promise((resolve) =>
      this.pendingRequests.set(`${sessionId}:${request.id}`, resolve),
    );
  }

  private attachExitHandler(sessionId: string, process: AppServer): void {
    this.exitUnsubscribers.set(
      sessionId,
      process.onExit?.(() => {
        this.processes.delete(sessionId);
        this.threadIds.delete(sessionId);
        this.clearPendingRequests(sessionId);
        this.planMeasurementTokens.delete(sessionId);
        this.exitUnsubscribers.delete(sessionId);
        this.releasePlanStatus(sessionId);
        this.onProcessExit?.(sessionId);
      }) ?? (() => {}),
    );
  }

  private async startThread(
    process: AppServer,
    session: RelaySessionSnapshot,
    settings: StartSessionSettings = {},
  ): Promise<string> {
    const result = (await process.rpc.request('thread/start', this.threadStartParams(session, settings))) as {
      thread?: { id?: unknown };
    };
    if (typeof result.thread?.id !== 'string' || !result.thread.id) {
      throw new Error('CODEX_THREAD_ID_MISSING');
    }
    return result.thread.id;
  }

  private threadStartParams(session: RelaySessionSnapshot, settings: StartSessionSettings): Record<string, unknown> {
    return {
      cwd: session.workspacePath,
      approvalPolicy: settings.approvalPolicy ?? 'on-request',
      dynamicTools: [gestaltQuizDynamicTool],
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    };
  }

  private discardProcess(sessionId: string, process: AppServer): void {
    this.exitUnsubscribers.get(sessionId)?.();
    this.exitUnsubscribers.delete(sessionId);
    process.close();
    this.clearPendingRequests(sessionId);
    this.planMeasurementTokens.delete(sessionId);
    this.releasePlanStatus(sessionId);
  }

  private clearPendingRequests(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.pendingRequests.keys()) {
      if (key.startsWith(prefix)) this.pendingRequests.delete(key);
    }
  }

  private async launchForSession(session: RelaySessionSnapshot): Promise<AppServer> {
    const lease = this.planStatusSource
      ? await this.planStatusSource.open(
          { id: session.id, workspacePath: session.workspacePath },
          (update) => this.onPlanStatus?.(session.id, update),
        )
      : undefined;
    if (lease) this.planStatusLeases.set(session.id, lease);
    try {
      const token = randomUUID();
      this.planMeasurementTokens.set(session.id, token);
      return this.launch({
        profile: session.profile,
        cwd: session.workspacePath,
        skillsConfig: await this.resolveSkills?.(session),
        ...((lease || this.planMeasurementBaseUrl)
          ? {
              environment: {
                ...(lease
                  ? { GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: lease.statusDirectory }
                  : {}),
                ...(this.planMeasurementBaseUrl
                  ? {
                      GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL:
                        `${this.planMeasurementBaseUrl}/api/sessions/${session.id}/plan-measurement`,
                      GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN: token,
                    }
                  : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      this.releasePlanStatus(session.id);
      throw error;
    }
  }

  private releasePlanStatus(sessionId: string): void {
    this.planStatusLeases.get(sessionId)?.close();
    this.planStatusLeases.delete(sessionId);
  }
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
