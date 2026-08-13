/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { buildApp } from './app.js';
import type { ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { protocolCompatibility } from './platform/codex/protocol-compatibility.js';
import { launchCodexAppServer } from './platform/codex/codex-process-launcher.js';
import { CodexModelCatalog } from './platform/codex/codex-model-catalog.js';
import { createRecentThreadLister } from './platform/codex/recent-thread-lister.js';
import { CodexSessionRuntime, type AppServer } from './platform/codex/session-runtime.js';
import { normalizeCodexNotification } from './platform/codex/normalizer.js';
import { migrate } from './platform/persistence/migrate.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';
import { SqliteAuthorizationStore } from './platform/auth/sqlite-authorization-store.js';
import { SimpleWebAuthnAdapter } from './platform/auth/simple-webauthn-adapter.js';
import type { WebAuthnCeremonyService } from './features/auth/application/ports.js';
import { authorizationSessionId, authorizedDeviceId } from './features/auth/domain/identifiers.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { SqliteEventJournal } from './platform/persistence/sqlite-event-journal.js';
import { SqlitePendingInteractionStore } from './platform/persistence/sqlite-pending-interaction-store.js';
import { SqliteIdempotencyStore } from './platform/persistence/sqlite-idempotency-store.js';
import { legacyRelayStatePath, relayStatePath } from './platform/persistence/state-path.js';
import { SessionEventBus } from './platform/events/session-event-bus.js';
import {
  checkoutBranch,
  cloneRepository,
  fetchUpstream,
  inspectGit,
  pullRebase,
  pushUpstream,
} from './platform/git/git-inspector.js';
import { GitFetchCoordinator } from './platform/git/git-fetch-coordinator.js';
import { GitSummaryCache } from './platform/git/git-summary-cache.js';
import { SessionSupervisor } from './platform/runtime/session-supervisor.js';
import { mapWithConcurrency } from './platform/runtime/concurrency.js';
import { RelaySession } from './features/sessions/model/relay-session.js';
import { toPendingInteraction } from './platform/codex/server-request.js';
import {
  isValidInteractionResponse,
  isValidQuizInteractionResponse,
} from './features/sessions/interaction/response-validator.js';
import { promoteRecentThread } from './features/sessions/promote-recent-thread/use-case.js';
import { FilesystemSkillProfileStore } from './platform/skills/filesystem-skill-profile-store.js';
import { CodexSkillCatalog } from './platform/skills/codex-skill-catalog.js';
import { CachedSkillCatalog } from './platform/skills/cached-skill-catalog.js';
import { compileSkillOverride, type SkillProfile } from './features/skills/model/skill-profile.js';
import { SupervisedPlanRegistry } from './features/plans/application/supervised-plan-registry.js';
import { FilesystemPlanStatusSource } from './platform/plans/filesystem-plan-status-source.js';
import { FilesystemWorkspacePlanCatalog } from './platform/plans/filesystem-workspace-plan-catalog.js';
import { checkpointPlanMeasurement } from './platform/plans/plan-measurement-command.js';
import { PlanMeasurementRefresh } from './platform/plans/plan-measurement-refresh.js';
import { createRelyingPartyConfig, type RelyingPartyConfig } from './config.js';

const generatedProtocolVersion = 'codex-cli 0.144.3';

export type ComposeRelayAppOptions = {
  root: string;
  dataDir?: string;
  /** Canonical, configuration-derived WebAuthn contract; never request-derived. */
  relyingParty: RelyingPartyConfig;
  passkeyAuthEnabled?: boolean;
  staticDir?: string;
  profiles: ProfileCatalog;
  installedCodexVersion: string | null;
  startAppServers?: boolean;
  launchAppServer?: (input: {
    profile: string;
    cwd: string;
    skillsConfig?: readonly { path: string; enabled: boolean }[];
    environment?: Readonly<Record<string, string>>;
  }) => AppServer;
  homeDirectory?: string;
  /** Testable source for the one durable opaque WebAuthn user handle. */
  authorizationRandomBytes?: (length: number) => Uint8Array;
  authorizationClock?: () => Date;
  /** Test seam; production always uses the SimpleWebAuthn adapter. */
  authorizationWebauthn?: WebAuthnCeremonyService;
  explicitSkillProfile?: SkillProfile;
  planMeasurementBaseUrl?: string;
  /** Absolute path to the trusted Org Plan helper permitted to checkpoint plans. */
  planMeasurementHelperPath?: string;
};

export async function composeRelayApp(options: ComposeRelayAppOptions) {
  const passkeyAuthEnabled = options.passkeyAuthEnabled ?? true;
  const relyingParty = createRelyingPartyConfig(options.relyingParty.publicOrigin);
  if (
    relyingParty.rpId !== options.relyingParty.rpId ||
    relyingParty.rpName !== options.relyingParty.rpName
  )
    throw new Error('Invalid WebAuthn relying-party configuration');
  const authorizationRandom = options.authorizationRandomBytes ?? randomBytes;
  const ownerHandle = passkeyAuthEnabled ? authorizationRandom(32) : undefined;
  if (ownerHandle && ownerHandle.length !== 32)
    throw new Error('Authorization randomness must return exactly 32 bytes');
  const root = resolve(options.root);
  const databasePath = options.dataDir
    ? join(resolve(options.dataDir), 'relay.sqlite')
    : resolveStateDatabasePath(
        root,
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      );
  const database = openRelayDatabase(databasePath);
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const sessions = new SqliteSessionRepository(database);
  const journal = new SqliteEventJournal(database);
  const interactions = new SqlitePendingInteractionStore(database);
  const idempotency = new SqliteIdempotencyStore(database);
  const supervisedPlans = new SupervisedPlanRegistry();
  const planStatusSource = new FilesystemPlanStatusSource(join(dirname(databasePath), 'plans'));
  const workspacePlanCatalog = new FilesystemWorkspacePlanCatalog();
  const planMeasurementHelperPath =
    options.planMeasurementHelperPath ?? process.env.GESTALT_MOBILE_ORG_PLAN_HELPER;
  const withPendingInteractions = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null,
  ) => (session ? { ...session, pendingInteractions: interactions.list(session.id) } : null);
  const events = new SessionEventBus();
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const models = new CodexModelCatalog(root, options.launchAppServer ?? launchCodexAppServer);
  const skillProfiles = new FilesystemSkillProfileStore(options.homeDirectory ?? homedir());
  const skillCatalog = (profile: string) =>
    new CodexSkillCatalog(profile, options.launchAppServer ?? launchCodexAppServer);
  const editorSkillCatalog = new CachedSkillCatalog((profile, workspace) =>
    skillCatalog(profile).list(workspace),
  );
  const resolveSkills = async (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
  ) => {
    const catalog = await skillCatalog(session.profile).list(session.workspacePath);
    if (session.effectiveSkillSelection)
      return compileSkillOverride({
        discovered: catalog.skills,
        explicit: session.effectiveSkillSelection.skills,
      }).skillsConfig;
    const project = await skillProfiles.readWorkspaceDefault(session.workspacePath);
    if (!options.explicitSkillProfile && !project) return undefined;
    return compileSkillOverride({
      discovered: catalog.skills,
      explicit: options.explicitSkillProfile?.skills,
      project: project?.skills,
    }).skillsConfig;
  };
  const recentThreads = createRecentThreadLister({
    root,
    profiles: options.profiles,
    launch: options.launchAppServer ?? launchCodexAppServer,
  });
  const protocol = protocolCompatibility(options.installedCodexVersion, generatedProtocolVersion);
  const gitFetches = new GitFetchCoordinator(fetchUpstream);
  const gitSummaries = new GitSummaryCache(inspectGit);
  let recoverExitedSession: (sessionId: string) => void = () => {};
  let planMeasurementRefresh: PlanMeasurementRefresh | undefined;
  const runtime = options.startAppServers
    ? new CodexSessionRuntime(
        options.launchAppServer ?? launchCodexAppServer,
        undefined,
        (sessionId, notification) => {
          const occurredAt = new Date().toISOString();
          const currentSession = sessions.find(sessionId);
          const normalized = normalizeCodexNotification(
            sessionId,
            0,
            occurredAt,
            notification,
            currentSession?.workspacePath,
            currentSession?.activeTurnId,
          );
          if (!normalized) return;
          let completedSession:
            import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | undefined;
          if (normalized.type === 'turnCompleted') {
            const turnId = (normalized.payload as { turn?: { id?: string } }).turn?.id;
            const session = sessions.find(sessionId);
            if (session && turnId && session.activeTurnId === turnId) {
              completedSession = RelaySession.rehydrate(session).completeTurn(
                turnId,
                occurredAt,
              ).snapshot;
              sessions.save(completedSession);
            }
            planMeasurementRefresh?.refreshNow(sessionId);
          }
          events.publish(
            journal.append(sessionId, normalized.type, normalized.payload, normalized.occurredAt),
          );
          if (completedSession)
            events.publish(
              journal.append(sessionId, 'session.updated', completedSession, occurredAt),
            );
        },
        (sessionId, request) => {
          const rawInteraction = toPendingInteraction(request);
          const session = withPendingInteractions(sessions.find(sessionId));
          if (!rawInteraction || !session) return false;
          const interaction = {
            ...rawInteraction,
            turnId: session.activeTurnId,
            requestedAt: new Date().toISOString(),
          };
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
        resolveSkills,
        planStatusSource,
        (sessionId, update) => {
          supervisedPlans.accept(sessionId, update);
          planMeasurementRefresh?.accept(sessionId, update);
          if (update.kind === 'updated') {
            void runtime?.syncThreadPlanName(sessionId, update.plan);
            const occurredAt = new Date().toISOString();
            const session = sessions.find(sessionId);
            if (session) {
              const updated = {
                ...session,
                lastOrgPlan: { filename: basename(update.planPath), title: update.plan.title },
                updatedAt: occurredAt,
              };
              sessions.save(updated);
              events.publish(journal.append(sessionId, 'session.updated', updated, occurredAt));
            }
            events.publish(
              journal.append(
                sessionId,
                'plan.updated',
                { plan: update.plan, reason: update.reason },
                occurredAt,
              ),
            );
          }
        },
        options.planMeasurementBaseUrl,
        30_000,
        64,
        root,
      )
    : null;
  if (runtime && planMeasurementHelperPath) {
    planMeasurementRefresh = new PlanMeasurementRefresh(
      async (sessionId) => {
        const session = sessions.find(sessionId);
        if (!session) throw new Error('CODEX_SESSION_NOT_RUNNING');
        return runtime.readPlanMeasurement(session);
      },
      (planPath, stepId, snapshot) =>
        checkpointPlanMeasurement(planMeasurementHelperPath, planPath, stepId, snapshot),
    );
  }
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
    // An exited child has released our writer.  Do not repeatedly resume a
    // durable thread: another Codex client may acquire it between callbacks.
    recoverExitedSession = (sessionId) => {
      supervisor.cancel(sessionId);
      const session = sessions.find(sessionId);
      if (session)
        saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
    };
  }
  let authorization: SqliteAuthorizationStore | undefined;
  if (passkeyAuthEnabled) {
    try {
      authorization = new SqliteAuthorizationStore(
        options.homeDirectory ?? homedir(),
        relyingParty,
      );
      authorization.initializeOwner(ownerHandle!);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  let app;
  try {
    app = await buildApp({
      ...(authorization
        ? {
            auth: {
              repository: authorization,
              clock: { now: options.authorizationClock ?? (() => new Date()) },
              random: {
                bytes: (length) => {
                  const value = authorizationRandom(length);
                  if (length !== 32 || value.length !== 32)
                    throw new Error('Authorization randomness must return exactly 32 bytes');
                  return value;
                },
              },
              identifiers: {
                sessionId: () => {
                  const value = authorizationRandom(32);
                  if (value.length !== 32)
                    throw new Error('Authorization randomness must return exactly 32 bytes');
                  return authorizationSessionId(Buffer.from(value).toString('base64url'));
                },
                deviceId: () => authorizedDeviceId(randomUUID()),
              },
              webauthn: options.authorizationWebauthn ?? new SimpleWebAuthnAdapter(),
              relyingParty,
            },
          }
        : { passkeyAuthDisabled: true }),
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
      skills: {
        workspaces,
        profiles: options.profiles,
        catalog: editorSkillCatalog,
        selections: skillProfiles,
        listGlobalProfileNames: () => skillProfiles.listGlobalProfileNames(),
        readGlobalProfile: (name) => skillProfiles.readGlobalProfile(name),
        replaceGlobalProfile: (profile) => skillProfiles.replaceGlobalProfile(profile),
        deleteGlobalProfile: (name) => skillProfiles.deleteGlobalProfile(name),
        profilePath: (name) => skillProfiles.globalProfilePath(name),
      },
      logger: console,
      staticDir: options.staticDir,
      recentThreads,
      bootstrap: {
        workspaces,
        profiles: options.profiles,
        models,
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
        skillProfiles,
        skillCatalog,
        defaultSkillProfile: options.explicitSkillProfile,
        activate: runtime
          ? async (session, settings) => runtime.start(session, new Date().toISOString(), settings)
          : undefined,
        startTurn: runtime
          ? async (session, text, clientUserMessageId) =>
              runtime.startTurn(session, text, clientUserMessageId, new Date().toISOString())
          : undefined,
        ensureWriter: runtime
          ? (session) => runtime.ensureWriter(session, new Date().toISOString())
          : undefined,
        releaseWriter: runtime ? (id) => runtime.release(id) : undefined,
        onTurnStarted: (session) => planMeasurementRefresh?.refreshNow(session.id),
        models,
        readHistory: runtime ? (session) => runtime.readHistory(session) : undefined,
        currentSequence: (sessionId) => journal.since(sessionId, 0).at(-1)?.sequence ?? 0,
        interruptTurn: runtime
          ? (session, turnId) => runtime.interruptTurn(session, turnId)
          : undefined,
        restore: runtime
          ? (session) => runtime.restoreWithOutcome(session, new Date().toISOString())
          : undefined,
        promoteRecent: runtime
          ? (thread) =>
              promoteRecentThread(thread, {
                createId: randomUUID,
                now: () => new Date().toISOString(),
                list: () => sessions.list(),
                save: saveSession,
                read: (session) => runtime.readHistory(session),
              })
          : undefined,
        release: (session) =>
          RelaySession.rehydrate(session).release(new Date().toISOString()).snapshot,
        remove: (id) => sessions.remove(id),
        idempotency,
        close: runtime
          ? (id) => {
              planMeasurementRefresh?.stop(id);
              return runtime.release(id);
            }
          : undefined,
        replyInteraction: runtime
          ? (sessionId, requestId, value) =>
              runtime.resolveServerRequest(sessionId, requestId, value)
          : undefined,
        interactionResolved: (sessionId, requestId, occurredAt, outcome) => {
          const interaction = interactions
            .snapshot(sessionId)
            .find((item) => item.requestId === requestId);
          events.publish(
            journal.append(
              sessionId,
              'interaction.resolved',
              { requestId, turnId: interaction?.turnId ?? null, resolvedAt: occurredAt, outcome },
              occurredAt,
            ),
          );
        },
      },
      sessionEvents: {
        exists: (id) => sessions.find(id) !== null,
        since: (id, after) => journal.since(id, after),
        subscribe: (id, listener) => events.subscribe(id, listener),
      },
      planRoutes: {
        exists: (id) => sessions.find(id) !== null,
        find: (id) => supervisedPlans.find(id),
        removeStatus: (id) =>
          planStatusSource.remove(id, supervisedPlans.identity(id) ?? undefined),
        clear: (id) => supervisedPlans.clear(id),
        closed: (id) => {
          planMeasurementRefresh?.stop(id);
          const occurredAt = new Date().toISOString();
          events.publish(journal.append(id, 'plan.closed', {}, occurredAt));
        },
      },
      workspacePlanRoutes: { workspaces, plans: workspacePlanCatalog },
      ...(runtime
        ? {
            planMeasurementRoutes: {
              exists: (id: string) => sessions.find(id) !== null,
              authorize: (id: string, authorization: string | undefined) =>
                runtime.authorizePlanMeasurement(id, authorization),
              read: async (id: string) => {
                const session = sessions.find(id);
                if (!session) throw new Error('CODEX_SESSION_NOT_RUNNING');
                return runtime.readPlanMeasurement(session);
              },
            },
          }
        : {}),
      interactions: {
        resolve: (sessionId, requestId, resolvedAt, outcome) =>
          interactions.resolve(sessionId, requestId, resolvedAt, outcome),
        alreadyResolved: (sessionId, requestId) => interactions.resolved(sessionId, requestId),
        snapshot: (sessionId) => interactions.snapshot(sessionId),
        pending: (sessionId, requestId) => interactions.find(sessionId, requestId) !== null,
        validate: (sessionId, requestId, value) => {
          const interaction = interactions.find(sessionId, requestId);
          if (!interaction) return false;
          if (interaction.kind === 'quiz')
            return isValidQuizInteractionResponse(interaction.payload, value);
          return isValidInteractionResponse(interaction.kind, value);
        },
      },
      gitSummary: {
        workspaces,
        inspect: async (path) => {
          const summary = await gitSummaries.inspect(path);
          const fetchedAt = gitFetches.lastSuccessfulAt(path);
          return { ...summary, fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null };
        },
        inspectForPush: inspectGit,
        push: async (path, upstream) => {
          await pushUpstream(path, upstream);
          gitSummaries.invalidate(path);
        },
        refresh: async (path) => {
          await gitFetches.refresh(path);
          gitSummaries.invalidate(path);
        },
        pull: async (path) => {
          await pullRebase(path);
          gitSummaries.invalidate(path);
        },
        checkout: async (path, branch) => {
          await checkoutBranch(path, branch);
          gitSummaries.invalidate(path);
        },
        clone: cloneRepository,
        idempotency,
      },
    });
  } catch (error) {
    authorization?.close();
    database.close();
    throw error;
  }
  const detachActiveSessions = async () => {
    await mapWithConcurrency(
      sessions.list().filter((session) => session.threadId !== null),
      2,
      async (session) => {
        if (session.desiredState === 'active')
          saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
        await runtime?.watchPlanStatus(session);
      },
    );
  };
  app.addHook('onListen', async () => {
    const profile = (await options.profiles.list()).find((item) => item.state === 'ok')?.name;
    if (profile) await editorSkillCatalog.refresh(profile, root);
    await detachActiveSessions();
  });
  app.addHook('onClose', async () => {
    planMeasurementRefresh?.stopAll();
    runtime?.stopAll();
    planStatusSource.closeAll();
    database.close();
    authorization?.close();
  });
  return app;
}

function resolveStateDatabasePath(root: string, stateHome: string): string {
  const currentPath = relayStatePath(root, stateHome);
  if (existsSync(currentPath)) return currentPath;
  const legacyPath = legacyRelayStatePath(root, stateHome);
  return existsSync(legacyPath) ? legacyPath : currentPath;
}
