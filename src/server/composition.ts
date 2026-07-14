import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildApp } from './app.js';
import type { ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { protocolCompatibility } from './platform/codex/protocol-compatibility.js';
import { launchCodexAppServer } from './platform/codex/codex-process-launcher.js';
import { CodexSessionRuntime } from './platform/codex/session-runtime.js';
import { normalizeCodexNotification } from './platform/codex/normalizer.js';
import { migrate } from './platform/persistence/migrate.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { SqliteEventJournal } from './platform/persistence/sqlite-event-journal.js';
import { SqlitePendingInteractionStore } from './platform/persistence/sqlite-pending-interaction-store.js';
import { relayStatePath } from './platform/persistence/state-path.js';
import { SessionEventBus } from './platform/events/session-event-bus.js';
import { fetchUpstream, inspectGit, pushUpstream } from './platform/git/git-inspector.js';
import { GitFetchCoordinator } from './platform/git/git-fetch-coordinator.js';
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
  const withPendingInteractions = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null,
  ) => (session ? { ...session, pendingInteractions: interactions.list(session.id) } : null);
  const events = new SessionEventBus();
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const protocol = protocolCompatibility(options.installedCodexVersion, generatedProtocolVersion);
  const gitFetches = new GitFetchCoordinator(fetchUpstream);
  const runtime = options.startAppServers
    ? new CodexSessionRuntime(
        launchCodexAppServer,
        undefined,
        (sessionId, notification) => {
          const occurredAt = new Date().toISOString();
          const normalized = normalizeCodexNotification(sessionId, 0, occurredAt, notification);
          if (!normalized) return;
          if (normalized.type === 'turnCompleted') {
            const turnId = (normalized.payload as { turn?: { id?: string } }).turn?.id;
            const session = sessions.find(sessionId);
            if (session && turnId && session.activeTurnId === turnId)
              sessions.save(RelaySession.rehydrate(session).completeTurn(turnId, occurredAt).snapshot);
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
      )
    : null;
  const saveSession = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
  ) => {
    sessions.save(session);
    events.publish(journal.append(session.id, 'session.updated', session, session.updatedAt));
  };
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
      interruptTurn: runtime ? (session, turnId) => runtime.interruptTurn(session, turnId) : undefined,
      restore: runtime ? (session) => runtime.restore(session, new Date().toISOString()) : undefined,
      release: (session) => RelaySession.rehydrate(session).release(new Date().toISOString()).snapshot,
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
    interactions,
    gitSummary: { inspect: inspectGit, push: pushUpstream, refresh: (path) => gitFetches.refresh(path) },
  });
  if (runtime) {
    await Promise.all(
      sessions
        .list()
        .filter((session) => session.desiredState === 'active' && session.threadId !== null)
        .map(async (session) => {
          try {
            saveSession(await runtime.restore(session, new Date().toISOString()));
          } catch {
            saveSession(
              RelaySession.rehydrate(session).requireAttention(new Date().toISOString()).snapshot,
            );
          }
        }),
    );
  }
  app.addHook('onClose', async () => {
    database.close();
  });
  return app;
}
