/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { authorizationSessionDevice } from '../../platform/http/authorization-boundary.js';
import { stopSession } from './lifecycle/use-case.js';
import { registerForgetSession } from './forget-session/endpoint.js';
import { registerGetHistory } from './get-history/endpoint.js';
import { registerGetSession } from './get-session/endpoint.js';
import { registerInterruptTurn } from './interrupt-turn/endpoint.js';
import { registerListRecentThreads } from './list-recent-threads/endpoint.js';
import { registerListSessions } from './list-sessions/endpoint.js';
import { registerPromoteRecentThread } from './promote-recent-thread/endpoint.js';
import { registerReleaseSession } from './release-session/endpoint.js';
import { registerRestoreSession } from './restore-session/endpoint.js';
import { registerRespondInteraction } from './respond-interaction/endpoint.js';
import { registerSelectModel } from './select-model/endpoint.js';
import { registerSessionEvents } from './session-events/endpoint.js';
import { registerStartSession } from './start-session/endpoint.js';
import { registerStartTurn } from './start-turn/endpoint.js';
import { registerStopSession } from './stop-session/endpoint.js';
import { registerRefreshActivity } from './refresh-activity/endpoint.js';

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: Pick<
    AppDependencies,
    'auth' | 'interactions' | 'logger' | 'recentThreads' | 'sessionEvents' | 'sessionRoutes'
  >,
): void {
  const sessions = deps.sessionRoutes;
  if (deps.recentThreads) {
    registerListRecentThreads(app, {
      ...deps.recentThreads,
      metadata: (threadId) => {
        const session = sessions?.list?.().find((candidate) => candidate.threadId === threadId);
        if (!session) return null;
        return {
          ...(session.model === undefined ? {} : { model: session.model }),
          ...(session.effectiveSkillSelection?.selectedProfileName === undefined
            ? {}
            : { skillProfile: session.effectiveSkillSelection.selectedProfileName }),
          ...(session.lastOrgPlan === undefined
            ? {}
            : { orgPlanFilename: session.lastOrgPlan.filename }),
        };
      },
    });
  }
  if (sessions) {
    registerStartSession(app, {
      ...sessions,
      reportFailure: (operation, error) =>
        deps.logger.error(`${operation} failed: ${safeErrorLabel(error)}`),
    });
    registerGetSession(app, sessions.find, sessions.agentActivity);
    if (sessions.refreshActivity)
      registerRefreshActivity(app, {
        exists: (id) => sessions.find(id) !== null,
        refresh: sessions.refreshActivity,
      });
    if (sessions.list)
      registerListSessions(app, { list: sessions.list, activity: sessions.agentActivity });
    if (sessions.readHistory)
      registerGetHistory(app, {
        find: sessions.find,
        read: sessions.readHistory,
        currentSequence: sessions.currentSequence ?? (() => 0),
        interactions: deps.interactions?.snapshot,
      });
    if (sessions.startTurn)
      registerStartTurn(app, {
        find: sessions.find,
        start: sessions.startTurn,
        ensureWriter: sessions.ensureWriter,
        releaseWriter: sessions.releaseWriter,
        save: sessions.save,
        onStarted: sessions.onTurnStarted,
        idempotency: sessions.idempotency,
      });
    if (sessions.models)
      registerSelectModel(app, {
        find: sessions.find,
        models: () => sessions.models!.list(),
        now: sessions.now,
        save: sessions.save,
      });
    if (sessions.interruptTurn)
      registerInterruptTurn(app, { find: sessions.find, interrupt: sessions.interruptTurn });
    if (sessions.restore)
      registerRestoreSession(app, {
        find: sessions.find,
        restore: sessions.restore,
        save: sessions.save,
        idempotency: sessions.idempotency,
      });
    if (deps.recentThreads && sessions.promoteRecent)
      registerPromoteRecentThread(app, {
        list: () => deps.recentThreads!.list(),
        promote: sessions.promoteRecent,
      });
    if (sessions.release && sessions.close)
      registerReleaseSession(app, {
        find: sessions.find,
        release: sessions.release,
        save: sessions.save,
        close: sessions.close,
        idempotency: sessions.idempotency,
      });
    if (sessions.remove && sessions.close)
      registerForgetSession(app, {
        find: sessions.find,
        close: sessions.close,
        remove: sessions.remove,
      });
    if (sessions.close)
      registerStopSession(app, {
        find: sessions.find,
        stop: (session) => stopSession(session, sessions.now()),
        save: sessions.save,
        close: sessions.close,
        idempotency: sessions.idempotency,
      });
    if (sessions.replyInteraction && deps.interactions)
      registerRespondInteraction(app, {
        exists: (id) => sessions.find(id) !== null,
        resolve: (sessionId, requestId, resolvedAt, outcome) =>
          deps.interactions!.resolve(sessionId, requestId, resolvedAt, outcome),
        validate: deps.interactions.validate,
        pending: deps.interactions.pending,
        alreadyResolved: deps.interactions.alreadyResolved,
        reply: sessions.replyInteraction,
        resolved: sessions.interactionResolved,
        now: sessions.now,
      });
  }
  if (deps.sessionEvents)
    registerSessionEvents(app, {
      ...deps.sessionEvents,
      ...(deps.auth
        ? {
            publicOrigin: deps.auth.relyingParty.publicOrigin,
            authorized: (cookieHeader: string | undefined) =>
              authorizationSessionDevice(cookieHeader, deps.auth!) !== null,
          }
        : {}),
    });
}

function safeErrorLabel(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}
