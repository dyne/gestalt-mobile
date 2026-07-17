import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';

import { registerGetHealth, type HealthReader } from './features/health/get-health/endpoint.js';
import { registerGetBootstrap } from './features/catalog/get-bootstrap/endpoint.js';
import { registerGetGitSummary } from './features/git/get-summary/endpoint.js';
import { registerPushUpstream } from './features/git/push-upstream/endpoint.js';
import { registerRefreshGit } from './features/git/refresh/endpoint.js';
import { registerPullRebase } from './features/git/pull-rebase/endpoint.js';
import { registerCheckoutBranch } from './features/git/checkout-branch/endpoint.js';
import type { BootstrapDependencies } from './features/catalog/get-bootstrap/use-case.js';
import type { ProfileCatalog, WorkspaceCatalog } from './features/catalog/application/ports.js';
import { registerGetSession } from './features/sessions/get-session/endpoint.js';
import { registerListSessions } from './features/sessions/list-sessions/endpoint.js';
import {
  registerListRecentThreads,
  type RecentThread,
} from './features/sessions/list-recent-threads/endpoint.js';
import { registerPromoteRecentThread } from './features/sessions/promote-recent-thread/endpoint.js';
import { registerGetHistory } from './features/sessions/get-history/endpoint.js';
import { registerStartSession } from './features/sessions/start-session/endpoint.js';
import { registerStartTurn } from './features/sessions/start-turn/endpoint.js';
import { registerInterruptTurn } from './features/sessions/interrupt-turn/endpoint.js';
import { registerStopSession } from './features/sessions/stop-session/endpoint.js';
import { registerRestoreSession } from './features/sessions/restore-session/endpoint.js';
import { registerReleaseSession } from './features/sessions/release-session/endpoint.js';
import { registerForgetSession } from './features/sessions/forget-session/endpoint.js';
import { registerRespondInteraction } from './features/sessions/respond-interaction/endpoint.js';
import { stopSession } from './features/sessions/lifecycle/use-case.js';
import { registerSessionEvents } from './features/sessions/session-events/endpoint.js';
import type { RelaySessionSnapshot } from './features/sessions/model/relay-session.js';
import type { SessionEvent } from '../shared/contracts/session-event.js';
import { registerProblemHandler } from './platform/http/problem-handler.js';
import type { StartSessionSettings } from './features/sessions/application/start-settings.js';

export type AppDependencies = {
  health: HealthReader;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  staticDir?: string;
  bootstrap?: BootstrapDependencies;
  recentThreads?: { list(): Promise<RecentThread[]> };
  sessionRoutes?: {
    createId(): string;
    now(): string;
    save(session: RelaySessionSnapshot): void;
    find(id: string): RelaySessionSnapshot | null;
    list?(): RelaySessionSnapshot[];
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    profiles: Pick<ProfileCatalog, 'require'>;
    activate?(
      session: RelaySessionSnapshot,
      settings: StartSessionSettings,
    ): Promise<RelaySessionSnapshot>;
    startTurn?(session: RelaySessionSnapshot, text: string): Promise<RelaySessionSnapshot>;
    close?(id: string): void;
    remove?(id: string): void;
    replyInteraction?(sessionId: string, requestId: string, value: unknown): boolean;
    readHistory?(session: RelaySessionSnapshot): Promise<{
      turns: import('./features/sessions/get-history/history-mapper.js').HistoryTurn[];
      activeTurnId: string | null;
    }>;
    currentSequence?(sessionId: string): number;
    interruptTurn?(session: RelaySessionSnapshot, turnId: string): Promise<void>;
    restore?(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
    promoteRecent?(thread: RecentThread): Promise<RelaySessionSnapshot>;
    release?(session: RelaySessionSnapshot): RelaySessionSnapshot;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
    interactionResolved?(sessionId: string, requestId: string, occurredAt: string): void;
  };
  sessionEvents?: {
    exists(id: string): boolean;
    since(id: string, after: number): SessionEvent[];
    subscribe(id: string, listener: (event: SessionEvent) => void): () => void;
  };
  interactions?: {
    resolve(sessionId: string, requestId: string, resolvedAt: string): boolean;
    validate?(sessionId: string, requestId: string, value: Record<string, unknown>): boolean;
  };
  gitSummary?: {
    inspect(path: string): Promise<import('./platform/git/git-inspector.js').WorkspaceGitSummary>;
    inspectForPush?(
      path: string,
    ): Promise<import('./platform/git/git-inspector.js').WorkspaceGitSummary>;
    push(path: string, upstream: string): Promise<void>;
    refresh(path: string): Promise<void>;
    pull?(path: string): Promise<void>;
    checkout?(path: string, branch: string): Promise<void>;
  };
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  if (deps.staticDir) await app.register(fastifyStatic, { root: deps.staticDir });
  registerGetHealth(app, deps.health);
  if (deps.bootstrap) registerGetBootstrap(app, deps.bootstrap);
  if (deps.recentThreads) registerListRecentThreads(app, deps.recentThreads);
  if (deps.sessionRoutes) {
    registerStartSession(app, {
      ...deps.sessionRoutes,
      reportFailure: (operation, error) =>
        deps.logger.error(`${operation} failed: ${safeErrorLabel(error)}`),
    });
    registerGetSession(app, deps.sessionRoutes.find);
    if (deps.sessionRoutes.list) registerListSessions(app, { list: deps.sessionRoutes.list });
    if (deps.sessionRoutes.readHistory)
      registerGetHistory(app, {
        find: deps.sessionRoutes.find,
        read: deps.sessionRoutes.readHistory,
        currentSequence: deps.sessionRoutes.currentSequence ?? (() => 0),
      });
    if (deps.sessionRoutes.startTurn)
      registerStartTurn(app, {
        find: deps.sessionRoutes.find,
        start: deps.sessionRoutes.startTurn,
        save: deps.sessionRoutes.save,
      });
    if (deps.sessionRoutes.interruptTurn)
      registerInterruptTurn(app, {
        find: deps.sessionRoutes.find,
        interrupt: deps.sessionRoutes.interruptTurn,
      });
    if (deps.sessionRoutes.restore)
      registerRestoreSession(app, {
        find: deps.sessionRoutes.find,
        restore: deps.sessionRoutes.restore,
        save: deps.sessionRoutes.save,
        idempotency: deps.sessionRoutes.idempotency,
      });
    if (deps.recentThreads && deps.sessionRoutes.promoteRecent)
      registerPromoteRecentThread(app, {
        list: () => deps.recentThreads!.list(),
        promote: deps.sessionRoutes.promoteRecent,
      });
    if (deps.sessionRoutes.release && deps.sessionRoutes.close)
      registerReleaseSession(app, {
        find: deps.sessionRoutes.find,
        release: deps.sessionRoutes.release,
        save: deps.sessionRoutes.save,
        close: deps.sessionRoutes.close,
        idempotency: deps.sessionRoutes.idempotency,
      });
    if (deps.sessionRoutes.remove && deps.sessionRoutes.close)
      registerForgetSession(app, {
        find: deps.sessionRoutes.find,
        close: deps.sessionRoutes.close,
        remove: deps.sessionRoutes.remove,
      });
    if (deps.sessionRoutes.close)
      registerStopSession(app, {
        find: deps.sessionRoutes.find,
        stop: (session) => stopSession(session, deps.sessionRoutes!.now()),
        save: deps.sessionRoutes.save,
        close: deps.sessionRoutes.close,
        idempotency: deps.sessionRoutes.idempotency,
      });
    if (deps.sessionRoutes.replyInteraction && deps.interactions)
      registerRespondInteraction(app, {
        exists: (id) => deps.sessionRoutes!.find(id) !== null,
        resolve: (sessionId, requestId, resolvedAt) =>
          deps.interactions!.resolve(sessionId, requestId, resolvedAt),
        validate: deps.interactions.validate,
        reply: deps.sessionRoutes.replyInteraction,
        resolved: deps.sessionRoutes.interactionResolved,
        now: deps.sessionRoutes.now,
      });
  }
  if (deps.sessionEvents) registerSessionEvents(app, deps.sessionEvents);
  if (deps.gitSummary && deps.sessionRoutes)
    registerGetGitSummary(app, { find: deps.sessionRoutes.find, inspect: deps.gitSummary.inspect });
  if (deps.gitSummary && deps.sessionRoutes)
    registerPushUpstream(app, {
      find: deps.sessionRoutes.find,
      inspect: deps.gitSummary.inspectForPush ?? deps.gitSummary.inspect,
      push: deps.gitSummary.push,
      idempotency: deps.sessionRoutes.idempotency,
    });
  if (deps.gitSummary && deps.sessionRoutes)
    registerRefreshGit(app, {
      find: deps.sessionRoutes.find,
      refresh: deps.gitSummary.refresh,
      idempotency: deps.sessionRoutes.idempotency,
    });
  if (deps.gitSummary?.pull && deps.gitSummary.checkout && deps.sessionRoutes) {
    registerPullRebase(app, { find: deps.sessionRoutes.find, pull: deps.gitSummary.pull });
    registerCheckoutBranch(app, {
      find: deps.sessionRoutes.find,
      checkout: deps.gitSummary.checkout,
    });
  }
  registerProblemHandler(app, Boolean(deps.staticDir));
  return app;
}

function safeErrorLabel(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}
