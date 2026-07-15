import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildApp } from './app.js';
import type { ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { protocolCompatibility } from './platform/codex/protocol-compatibility.js';
import { launchCodexAppServer } from './platform/codex/codex-process-launcher.js';
import { createRecentThreadLister } from './platform/codex/recent-thread-lister.js';
import { CodexSessionRuntime, type AppServer } from './platform/codex/session-runtime.js';
import { normalizeCodexNotification } from './platform/codex/normalizer.js';
import { migrate } from './platform/persistence/migrate.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { SqliteEventJournal } from './platform/persistence/sqlite-event-journal.js';
import { SqlitePendingInteractionStore } from './platform/persistence/sqlite-pending-interaction-store.js';
import { SqliteIdempotencyStore } from './platform/persistence/sqlite-idempotency-store.js';
import { relayStatePath } from './platform/persistence/state-path.js';
import { SessionEventBus } from './platform/events/session-event-bus.js';
import { fetchUpstream, inspectGit, pushUpstream } from './platform/git/git-inspector.js';
import { GitFetchCoordinator } from './platform/git/git-fetch-coordinator.js';
import { SessionSupervisor } from './platform/runtime/session-supervisor.js';
import { mapWithConcurrency } from './platform/runtime/concurrency.js';
import { RelaySession } from './features/sessions/model/relay-session.js';
import { toPendingInteraction } from './platform/codex/server-request.js';

const generatedProtocolVersion = 'codex-cli 0.144.3';

export type ComposeRelayAppOptions = {
  root: string;
  dataDir?: string;
  staticDir?: string;
  profiles: ProfileCatalog;
  installedCodexVersion: string | null;
  startAppServers?: boolean;
  launchAppServer?: (input: { profile: string; cwd: string }) => AppServer;
};

export async function composeRelayApp(options: ComposeRelayAppOptions) {
  const root = resolve(options.root);
  const databasePath = options.dataDir
    ? join(resolve(options.dataDir), 'relay.sqlite')
    : relayStatePath(root, process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'));
  const database = openRelayDatabase(databasePath);
  migrate(database);
  const sessions = new SqliteSessionRepository(database);
  const journal = new SqliteEventJournal(database);
  const interactions = new SqlitePendingInteractionStore(database);
  const idempotency = new SqliteIdempotencyStore(database);
  const withPendingInteractions = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null,
  ) => (session ? { ...session, pendingInteractions: interactions.list(session.id) } : null);
  const events = new SessionEventBus();
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const recentThreads = createRecentThreadLister({
    root,
    profiles: options.profiles,
    launch: options.launchAppServer ?? launchCodexAppServer,
  });
  const protocol = protocolCompatibility(options.installedCodexVersion, generatedProtocolVersion);
  const gitFetches = new GitFetchCoordinator(fetchUpstream);
  let recoverExitedSession: (sessionId: string) => void = () => {};
  const runtime = options.startAppServers
    ? new CodexSessionRuntime(
        options.launchAppServer ?? launchCodexAppServer,
        undefined,
        (sessionId, notification) => {
          const occurredAt = new Date().toISOString();
          const normalized = normalizeCodexNotification(sessionId, 0, occurredAt, notification);
          if (!normalized) return;
          if (normalized.type === 'turnCompleted') {
            const turnId = (normalized.payload as { turn?: { id?: string } }).turn?.id;
            const session = sessions.find(sessionId);
            if (session && turnId && session.activeTurnId === turnId)
              sessions.save(
                RelaySession.rehydrate(session).completeTurn(turnId, occurredAt).snapshot,
              );
          }
          events.publish(
            journal.append(sessionId, normalized.type, normalized.payload, normalized.occurredAt),
          );
        },
        (sessionId, request) => {
          const interaction = toPendingInteraction(request);
          const session = withPendingInteractions(sessions.find(sessionId));
          if (!interaction || !session) return false;
          interactions.add(sessionId, interaction);
          const updated = RelaySession.rehydrate(session).requestInteraction(
            interaction,
            new Date().toISOString(),
          ).snapshot;
          sessions.save(updated);
          events.publish(
            journal.append(sessionId, 'interaction.requested', interaction, updated.updatedAt),
          );
          return true;
        },
        (sessionId) => recoverExitedSession(sessionId),
      )
    : null;
  const saveSession = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
  ) => {
    sessions.save(session);
    events.publish(journal.append(session.id, 'session.updated', session, session.updatedAt));
  };
  if (runtime) {
    const supervisor = new SessionSupervisor(
      async (sessionId) => {
        const session = sessions.find(sessionId);
        if (!session || session.desiredState !== 'active' || !session.threadId) return;
        const recovering = RelaySession.rehydrate(session).beginRecovery(
          new Date().toISOString(),
        ).snapshot;
        saveSession(recovering);
        saveSession(await runtime.restore(recovering, new Date().toISOString()));
      },
      (sessionId) => {
        const session = sessions.find(sessionId);
        if (session)
          saveSession(
            RelaySession.rehydrate(session).requireAttention(new Date().toISOString()).snapshot,
          );
      },
    );
    recoverExitedSession = (sessionId) => supervisor.recover(sessionId);
  }
  const app = await buildApp({
    health: {
      async read() {
        return {
          status: protocol.compatible ? 'ok' : 'degraded',
          version: '0.1.0',
          codex: {
            installedVersion: options.installedCodexVersion,
            protocolVersion: generatedProtocolVersion,
            compatible: protocol.compatible,
          },
        };
      },
    },
    logger: console,
    staticDir: options.staticDir,
    recentThreads,
    bootstrap: {
      workspaces,
      profiles: options.profiles,
      sessions: {
        list: () => sessions.list().map((session) => withPendingInteractions(session)!),
      },
      protocolCompatible: protocol.compatible,
    },
    sessionRoutes: {
      createId: randomUUID,
      now: () => new Date().toISOString(),
      save: saveSession,
      find: (id) => withPendingInteractions(sessions.find(id)),
      list: () => sessions.list().map((session) => withPendingInteractions(session)!),
      workspaces,
      profiles: options.profiles,
      activate: runtime
        ? async (session) => runtime.start(session, new Date().toISOString())
        : undefined,
      startTurn: runtime
        ? async (session, text) => runtime.startTurn(session, text, new Date().toISOString())
        : undefined,
      readHistory: runtime ? (session) => runtime.readHistory(session) : undefined,
      currentSequence: (sessionId) => journal.since(sessionId, 0).at(-1)?.sequence ?? 0,
      interruptTurn: runtime
        ? (session, turnId) => runtime.interruptTurn(session, turnId)
        : undefined,
      restore: runtime
        ? (session) => runtime.restore(session, new Date().toISOString())
        : undefined,
      release: (session) =>
        RelaySession.rehydrate(session).release(new Date().toISOString()).snapshot,
      idempotency,
      close: runtime ? (id) => runtime.stop(id) : undefined,
      replyInteraction: runtime
        ? (sessionId, requestId, value) => runtime.resolveServerRequest(sessionId, requestId, value)
        : undefined,
      interactionResolved: (sessionId, requestId, occurredAt) => {
        events.publish(
          journal.append(sessionId, 'interaction.resolved', { requestId }, occurredAt),
        );
      },
    },
    sessionEvents: {
      exists: (id) => sessions.find(id) !== null,
      since: (id, after) => journal.since(id, after),
      subscribe: (id, listener) => events.subscribe(id, listener),
    },
    interactions: {
      resolve: (sessionId, requestId, resolvedAt) =>
        interactions.resolve(sessionId, requestId, resolvedAt),
      validate: (sessionId, requestId, value) => {
        const interaction = interactions.find(sessionId, requestId);
        if (!interaction) return false;
        if (interaction.kind === 'userInput') return isRecord(value.answers);
        if (interaction.kind === 'permissionsApproval')
          return (
            isRecord(value.permissions) && (value.scope === 'turn' || value.scope === 'session')
          );
        return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(
          value.decision as string,
        );
      },
    },
    gitSummary: {
      inspect: async (path) => {
        const summary = await inspectGit(path);
        const fetchedAt = gitFetches.lastSuccessfulAt(path);
        return { ...summary, fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null };
      },
      push: pushUpstream,
      refresh: (path) => gitFetches.refresh(path),
    },
  });
  if (runtime) {
    await mapWithConcurrency(
      sessions
        .list()
        .filter((session) => session.desiredState === 'active' && session.threadId !== null),
      2,
      async (session) => {
        try {
          saveSession(await runtime.restore(session, new Date().toISOString()));
        } catch {
          saveSession(
            RelaySession.rehydrate(session).requireAttention(new Date().toISOString()).snapshot,
          );
        }
      },
    );
  }
  app.addHook('onClose', async () => {
    database.close();
  });
  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
