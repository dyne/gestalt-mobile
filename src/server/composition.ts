import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildApp } from './app.js';
import type { ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { protocolCompatibility } from './platform/codex/protocol-compatibility.js';
import { launchCodexAppServer } from './platform/codex/codex-process-launcher.js';
import { CodexSessionRuntime } from './platform/codex/session-runtime.js';
import { migrate } from './platform/persistence/migrate.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { SqliteEventJournal } from './platform/persistence/sqlite-event-journal.js';
import { relayStatePath } from './platform/persistence/state-path.js';
import { SessionEventBus } from './platform/events/session-event-bus.js';

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
  const events = new SessionEventBus();
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const protocol = protocolCompatibility(options.installedCodexVersion, generatedProtocolVersion);
  const runtime = options.startAppServers ? new CodexSessionRuntime(launchCodexAppServer) : null;
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
      sessions,
      protocolCompatible: protocol.compatible,
    },
    sessionRoutes: {
      createId: randomUUID,
      now: () => new Date().toISOString(),
      save: (session) => {
        sessions.save(session);
        events.publish(journal.append(session.id, 'session.updated', session, session.updatedAt));
      },
      find: (id) => sessions.find(id),
      workspaces,
      profiles: options.profiles,
      activate: runtime
        ? async (session) => runtime.start(session, new Date().toISOString())
        : undefined,
    },
    sessionEvents: {
      exists: (id) => sessions.find(id) !== null,
      since: (id, after) => journal.since(id, after),
      subscribe: (id, listener) => events.subscribe(id, listener),
    },
  });
  app.addHook('onClose', async () => {
    database.close();
  });
  return app;
}
