/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { buildApp } from './app.js';
import type { ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { FilesystemWorkspaceFiles } from './platform/filesystem/filesystem-workspace-files.js';
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
import {
  RelaySession,
  type RelaySessionSnapshot,
} from './features/sessions/model/relay-session.js';
import { AgentActivityRegistry } from './features/agent-activity/registry.js';
import { decodeAgentActivityFacts } from './platform/codex/activity-facts.js';
import { resolvedServerRequestId, toPendingInteraction } from './platform/codex/server-request.js';
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
import type { PlanStatusUpdate } from './features/plans/application/ports.js';
import { FilesystemPlanStatusSource } from './platform/plans/filesystem-plan-status-source.js';
import { FilesystemWorkspacePlanCatalog } from './platform/plans/filesystem-workspace-plan-catalog.js';
import { checkpointPlanMeasurement } from './platform/plans/plan-measurement-command.js';
import { PlanMeasurementRefresh } from './platform/plans/plan-measurement-refresh.js';
import { SqliteAutopilotStore } from './platform/persistence/sqlite-autopilot-store.js';
import { AutopilotCoordinator } from './features/autopilot/application/service.js';
import {
  AUTOPILOT_CONTINUATION_PROMPT,
  AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT,
  defaultAutopilotPolicy,
} from './features/autopilot/application/policy.js';
import { createRelyingPartyConfig, type RelyingPartyConfig } from './config.js';
import type { SafeInteractionOutcome } from '../shared/contracts/chat-snapshot.js';
import type { OrgPlanAttention } from '../shared/contracts/org-plan-attention.js';
import { parseOrgPlanAttention } from '../shared/contracts/org-plan-attention.js';
import type { OrgPlanAttentionTransitions } from './features/org-plan-attention/application/ports.js';

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
  activityDiagnostic?: (sessionId: string, code: 'reconcileExhausted') => void;
  activitySchedule?: (callback: () => void, delayMs: number) => () => void;
  /** Test-only deterministic seam around the production coordinator timer. */
  autopilotSchedule?: (callback: () => void, delayMs: number) => () => void;
  /** Test-only deterministic seam for the runtime activity reconciliation boundary. */
  autopilotReconcile?: (sessionId: string) => Promise<{ compatible: boolean }>;
  /** Test-only activity projection seam for deterministic stale reconciliation. */
  autopilotActivity?: (
    sessionId: string,
  ) => import('./features/agent-activity/model.js').AgentActivitySnapshot | null;
  /** Test-only crash window after a runtime accepts, persists, and fences a turn. */
  autopilotAfterTurnAccepted?: (input: {
    sessionId: string;
    controlId: string;
    turnId: string;
  }) => Promise<void> | void;
  /** Test-only fault seam before the runtime accepts a synthetic turn. */
  autopilotBeforeTurnAccepted?: (input: {
    sessionId: string;
    controlId: string;
  }) => Promise<void> | void;
  /** Test-only observer for driving recovery through the production composition. */
  onAutopilotCoordinator?: (coordinator: AutopilotCoordinator) => void;
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
  /** Test-only typed feature seam; adapters remain private to composition. */
  onAttentionTransitions?: (port: OrgPlanAttentionTransitions) => void;
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
  // Only sessions found while opening the relay database belong to a previous
  // process. A listen hook can run after a new session has already started in
  // this process; detaching that live writer would make restore and activity
  // reconciliation race their own owner.
  const persistedSessionIds = new Set(sessions.list().map((session) => session.id));
  const journal = new SqliteEventJournal(database);
  const interactions = new SqlitePendingInteractionStore(database);
  const idempotency = new SqliteIdempotencyStore(database);
  const autopilotStore = new SqliteAutopilotStore(database);
  const attentionResolutionOperations = new Map<
    string,
    Promise<
      | { kind: 'accepted'; resolvedAt: string }
      | { kind: 'replayed'; resolvedAt: string }
      | {
          kind:
            | 'noActive'
            | 'staleOperation'
            | 'writerUnavailable'
            | 'writerCleared'
            | 'legacyUnsupported';
          resolvedAt?: string;
        }
    >
  >();
  const supervisedPlans = new SupervisedPlanRegistry();
  const planStatusSource = new FilesystemPlanStatusSource(join(dirname(databasePath), 'plans'));
  const planMeasurementHelperPath =
    options.planMeasurementHelperPath ?? process.env.GESTALT_MOBILE_ORG_PLAN_HELPER;
  const withPendingInteractions = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null,
  ) => (session ? { ...session, pendingInteractions: interactions.list(session.id) } : null);
  const events = new SessionEventBus();
  let notifyAutopilotActivity: (sessionId: string) => void = () => undefined;
  const attentionTransitions: OrgPlanAttentionTransitions = {
    subscribe: (sessionId, listener) =>
      events.subscribe(sessionId, (event) => {
        if (
          event.type !== 'org-plan.attention-required' &&
          event.type !== 'org-plan.attention-resolved'
        )
          return;
        const payload = event.payload as { requestId?: unknown; outcome?: unknown };
        if (typeof payload.requestId !== 'string') return;
        listener({
          kind:
            event.type === 'org-plan.attention-required'
              ? 'required'
              : payload.outcome === 'failed'
                ? 'failed'
                : 'resolved',
          requestId: payload.requestId,
          occurredAt: event.occurredAt,
        });
      }),
  };
  options.onAttentionTransitions?.(attentionTransitions);
  const activity = new AgentActivityRegistry(
    (snapshot, occurredAt) => {
      events.publish(
        journal.append(snapshot.sessionId, 'agent.activity.updated', snapshot, occurredAt),
      );
      notifyAutopilotActivity(snapshot.sessionId);
    },
    {
      // Evidence arms one bounded reconciliation; healthy sessions are never polled.
      schedule:
        options.activitySchedule ??
        ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        }),
      now: () => new Date().toISOString(),
      diagnostic:
        options.activityDiagnostic ??
        ((sessionId, code) => console.warn(`agent activity ${code} session=${sessionId}`)),
      reconcile: async (sessionId) => {
        const session = sessions.find(sessionId);
        if (!session || !runtime) return;
        const history = await runtime.readHistory(session);
        // Forget may commit while the detached history reader is still in
        // flight. Revalidate ownership before handing its result to the
        // registry, whose publisher intentionally keeps the journal strict.
        if (!sessions.find(sessionId)) return;
        const occurredAt = new Date().toISOString();
        activity.observe({
          sessionId,
          occurredAt,
          kind: history.activeTurnId ? 'turnStarted' : 'turnCompleted',
          ...(session.threadId ? { threadId: session.threadId } : {}),
          ...(history.activeTurnId ? { turnId: history.activeTurnId } : {}),
        });
        const children = await runtime.listDirectChildren(session);
        const childProcesses = new Map<
          string,
          Awaited<ReturnType<CodexSessionRuntime['inspectChildProcesses']>>
        >();
        await mapWithConcurrency([...children], 4, async (child) => {
          childProcesses.set(child.id, await runtime!.inspectChildProcesses(session, child));
        });
        // The writer read is also asynchronous; it cannot publish after the
        // durable owner has gone away either.
        if (!sessions.find(sessionId)) return;
        activity.childrenReconciled(
          sessionId,
          occurredAt,
          children.map((child) => ({
            ...child,
            processes: childProcesses.get(child.id) ?? [],
          })),
        );
      },
    },
  );
  const autopilot = new AutopilotCoordinator({
    store: autopilotStore,
    now: () => new Date().toISOString(),
    policy: defaultAutopilotPolicy,
    plan: (sessionId) => {
      const plan = supervisedPlans.find(sessionId);
      const identity = supervisedPlans.identity(sessionId);
      return plan && identity ? { plan, identity } : null;
    },
    session: (sessionId) => sessions.find(sessionId),
    activity: (sessionId) =>
      options.autopilotActivity
        ? options.autopilotActivity(sessionId)
        : activity.snapshot(sessionId, new Date().toISOString()),
    pendingInteraction: (sessionId) => interactions.list(sessionId).length > 0,
    attention: (sessionId) => {
      const interaction = interactions
        .list(sessionId)
        .find((candidate) => candidate.kind === 'orgPlanAttention');
      const attention = interaction ? parseOrgPlanAttention(interaction.payload) : null;
      return attention
        ? { reason: attention.reason, resumeCondition: attention.resumeCondition }
        : null;
    },
    reconcile: async (sessionId) => {
      if (options.autopilotReconcile) return options.autopilotReconcile(sessionId);
      await activity.refresh(sessionId);
      return {
        compatible: activity.snapshot(sessionId, new Date().toISOString()).confidence === 'fresh',
      };
    },
    schedule:
      options.autopilotSchedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      }),
    nextControlId: (sessionId, generation) =>
      `autopilot-${generation}-${createHash('sha256').update(`${sessionId}:${randomUUID()}`).digest('hex').slice(0, 16)}`,
    turnStarter: {
      start: async (sessionId, controlId, generation, launchIdentity) => {
        const current = () => {
          const state = autopilotStore.find(sessionId);
          return Boolean(
            state &&
            state.requestedEnabled &&
            state.generation === generation &&
            state.lastControlId === controlId,
          );
        };
        if (!current()) throw new Error('AUTOPILOT_START_UNAVAILABLE');
        const session = sessions.find(sessionId);
        if (!session || !runtime || session.activeTurnId || interactions.list(sessionId).length)
          throw new Error('AUTOPILOT_START_UNAVAILABLE');
        // A relay restart can leave a durable, otherwise eligible session without this
        // process's writer. Reacquire through the normal ownership boundary before a
        // synthetic start; never bypass its single-writer and replacement semantics.
        const writer = await runtime.ensureWriter(session, new Date().toISOString());
        if (!current() || writer.session.activeTurnId || interactions.list(sessionId).length)
          throw new Error('AUTOPILOT_START_UNAVAILABLE');
        await options.autopilotBeforeTurnAccepted?.({ sessionId, controlId });
        const continuationPrompt = launchIdentity
          ? `${AUTOPILOT_CONTINUATION_PROMPT} Launch task_name ${launchIdentity.taskName} for canonical ${launchIdentity.canonicalPosition}; retain the canonical label in status and review output.`
          : AUTOPILOT_CONTINUATION_PROMPT;
        const started = await runtime.startTurn(
          writer.session,
          continuationPrompt,
          controlId,
          new Date().toISOString(),
        );
        if (!started.activeTurnId) throw new Error('AUTOPILOT_START_UNAVAILABLE');
        sessions.save(started);
        await options.autopilotAfterTurnAccepted?.({
          sessionId,
          controlId,
          turnId: started.activeTurnId,
        });
        activity.observe({
          sessionId,
          occurredAt: started.updatedAt,
          kind: 'turnStarted',
          ...(started.threadId ? { threadId: started.threadId } : {}),
          ...(started.activeTurnId ? { turnId: started.activeTurnId } : {}),
        });
      },
    },
    executorController: {
      resume: async (sessionId, threadId, generation, trigger) => {
        const session = sessions.find(sessionId);
        if (!session || !runtime || interactions.list(sessionId).length)
          throw new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE');
        const writer = await runtime.ensureWriter(session, new Date().toISOString());
        if (interactions.list(sessionId).length) throw new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE');
        const context =
          trigger.kind === 'processExited'
            ? ` Process result ${trigger.resultArtifact} exited and is ready in this executor history.`
            : trigger.kind === 'processResourceLimit'
              ? ` Process ${trigger.processId} exceeded its explicit resource budget and was terminated; diagnose before retrying.`
              : '';
        const clientId = `autopilot-executor-${generation}-${createHash('sha256')
          .update(`${sessionId}:${threadId}:${generation}:${randomUUID()}`)
          .digest('hex')
          .slice(0, 16)}`;
        const turnId = await runtime.startExecutorTurn(
          writer.session,
          threadId,
          `${AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT}${context}`,
          clientId,
        );
        activity.observe({
          sessionId,
          occurredAt: new Date().toISOString(),
          kind: 'turnStarted',
          threadId,
          turnId,
        });
      },
      refresh: (sessionId) => activity.refresh(sessionId),
      transferProcess: (sessionId, threadId, processId) => {
        activity.transferProcessOwnership(sessionId, threadId, processId, new Date().toISOString());
      },
      consumeProcess: (sessionId, threadId, processId) => {
        runtime?.consumeChildProcessResult(sessionId, threadId, processId);
      },
      terminateProcess: async (sessionId, threadId, processId) => {
        const session = sessions.find(sessionId);
        return session && runtime
          ? runtime.terminateChildProcess(session, threadId, processId)
          : false;
      },
    },
    publish: (sessionId, type, payload, occurredAt, outboxId) => {
      if (!sessions.find(sessionId)) return;
      events.publish(journal.append(sessionId, type, payload, occurredAt, outboxId));
    },
  });
  notifyAutopilotActivity = (sessionId) => autopilot.activityChanged(sessionId);
  options.onAutopilotCoordinator?.(autopilot);
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const workspaceFiles = new FilesystemWorkspaceFiles();
  const models = new CodexModelCatalog(root, options.launchAppServer ?? launchCodexAppServer);
  const skillProfiles = new FilesystemSkillProfileStore(options.homeDirectory ?? homedir());
  const skillCatalog = (profile: string) =>
    new CodexSkillCatalog(profile, options.launchAppServer ?? launchCodexAppServer);
  const editorSkillCatalog = new CachedSkillCatalog((profile, workspace) =>
    skillCatalog(profile).list(workspace),
  );
  const workspacePlanCatalog = new FilesystemWorkspacePlanCatalog();
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
  const recoverExecutionPolicy = async (
    session: RelaySessionSnapshot,
  ): Promise<RelaySessionSnapshot> => {
    if (session.executionPolicy || !session.threadId) return session;
    const executionPolicy = await recentThreads.executionPolicy(session.threadId);
    return executionPolicy
      ? { ...session, executionPolicy, updatedAt: new Date().toISOString() }
      : session;
  };
  const protocol = protocolCompatibility(options.installedCodexVersion, generatedProtocolVersion);
  const gitFetches = new GitFetchCoordinator(fetchUpstream);
  const gitSummaries = new GitSummaryCache(inspectGit);
  let recoverExitedSession: (sessionId: string) => void = () => {};
  let planMeasurementRefresh: PlanMeasurementRefresh | undefined;
  const publishInteractionResolved = (
    sessionId: string,
    requestId: string,
    occurredAt: string,
    outcome: SafeInteractionOutcome,
  ) => {
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
    if (interaction?.kind === 'orgPlanAttention')
      events.publish(
        journal.append(
          sessionId,
          'org-plan.attention-resolved',
          { requestId, turnId: interaction.turnId ?? null, resolvedAt: occurredAt, outcome },
          occurredAt,
        ),
      );
  };
  const publishAttentionSettlement = (
    sessionId: string,
    requestId: string,
    occurredAt: string,
    outcome: Extract<SafeInteractionOutcome, 'answered' | 'failed'>,
  ) => {
    const remaining = interactions.list(sessionId);
    const attention = remaining.find((item) => item.kind === 'orgPlanAttention');
    activity.observe({
      sessionId,
      occurredAt,
      kind: 'interactionResolved',
      hasPendingInteraction: remaining.length > 0,
      ...(attention ? { attentionReason: (attention.payload as OrgPlanAttention).reason } : {}),
    });
    publishInteractionResolved(sessionId, requestId, occurredAt, outcome);
  };
  const dismissPendingInteractions = (
    sessionId: string,
    occurredAt: string,
    outcome: SafeInteractionOutcome = 'dismissed',
  ) => {
    for (const interaction of interactions.list(sessionId)) {
      if (interactions.resolve(sessionId, interaction.requestId, occurredAt, outcome))
        publishInteractionResolved(sessionId, interaction.requestId, occurredAt, outcome);
    }
  };
  let closing = false;
  let runtime: CodexSessionRuntime | null = null;
  const acceptPlanUpdate = (sessionId: string, update: PlanStatusUpdate): void => {
    if (closing) return;
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
    if (update.kind === 'updated' && update.reason === 'supervision-start')
      autopilot.supervisionStarted(sessionId);
    autopilot.planStatusChanged(sessionId);
  };
  runtime = options.startAppServers
    ? new CodexSessionRuntime(
        options.launchAppServer ?? launchCodexAppServer,
        undefined,
        (sessionId, notification) => {
          const occurredAt = new Date().toISOString();
          for (const activityFact of decodeAgentActivityFacts(sessionId, occurredAt, notification))
            activity.observe(activityFact);
          const resolvedRequestId = resolvedServerRequestId(notification);
          if (resolvedRequestId) {
            const interaction = interactions.find(sessionId, resolvedRequestId);
            const outcome = interaction?.kind === 'orgPlanAttention' ? 'failed' : 'dismissed';
            if (interactions.resolve(sessionId, resolvedRequestId, occurredAt, outcome)) {
              if (outcome === 'failed')
                publishAttentionSettlement(sessionId, resolvedRequestId, occurredAt, outcome);
              else publishInteractionResolved(sessionId, resolvedRequestId, occurredAt, outcome);
            }
          }
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
              autopilot.turnCompleted(sessionId);
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
          activity.observe({
            sessionId,
            occurredAt: interaction.requestedAt,
            kind: 'interactionPending',
            ...(interaction.kind === 'orgPlanAttention'
              ? { attentionReason: (interaction.payload as OrgPlanAttention).reason }
              : {}),
          });
          const updated = RelaySession.rehydrate(session).requestInteraction(
            interaction,
            new Date().toISOString(),
          ).snapshot;
          sessions.save(updated);
          events.publish(
            journal.append(sessionId, 'interaction.requested', interaction, updated.updatedAt),
          );
          if (interaction.kind === 'orgPlanAttention')
            events.publish(
              journal.append(
                sessionId,
                'org-plan.attention-required',
                interaction,
                updated.updatedAt,
              ),
            );
          autopilot.evaluate(sessionId);
          return true;
        },
        (sessionId) => {
          activity.disconnected(sessionId, new Date().toISOString());
          dismissPendingInteractions(sessionId, new Date().toISOString(), 'failed');
          recoverExitedSession(sessionId);
        },
        resolveSkills,
        planStatusSource,
        acceptPlanUpdate,
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
    const prior = sessions.find(session.id);
    sessions.save(session);
    events.publish(journal.append(session.id, 'session.updated', session, session.updatedAt));
    const becameRuntimeReady =
      prior &&
      prior.state !== 'ready' &&
      prior.state !== 'turnActive' &&
      (session.state === 'ready' || session.state === 'turnActive');
    if (
      runtime &&
      session.threadId &&
      (!prior || prior.threadId !== session.threadId || becameRuntimeReady)
    )
      void activity.refresh(session.id);
    if (becameRuntimeReady) autopilot.restore(session.id);
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
        const restored = await runtime.restore(recovering, new Date().toISOString());
        saveSession(restored);
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
      if (session) {
        autopilot.cancel(sessionId, 'sessionEnded');
        saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
      }
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
          list: () =>
            sessions.list().map((session) => {
              const plan = supervisedPlans.find(session.id);
              return {
                ...withPendingInteractions(session)!,
                ...(plan ? { plan } : {}),
              };
            }),
        },
        protocolCompatible: protocol.compatible,
      },
      sessionRoutes: {
        createId: randomUUID,
        now: () => new Date().toISOString(),
        save: saveSession,
        find: (id) => withPendingInteractions(sessions.find(id)),
        list: () => sessions.list().map((session) => withPendingInteractions(session)!),
        plan: (id) => supervisedPlans.find(id),
        workspaces,
        profiles: options.profiles,
        skillProfiles,
        skillCatalog,
        defaultSkillProfile: options.explicitSkillProfile,
        activate: runtime
          ? async (session) => {
              const now = new Date().toISOString();
              dismissPendingInteractions(session.id, now);
              const started = await runtime.start(session, now);
              return started;
            }
          : undefined,
        startTurn: runtime
          ? async (session, text, clientUserMessageId) => {
              autopilot.manualSend(session.id);
              return runtime.startTurn(
                session,
                text,
                clientUserMessageId,
                new Date().toISOString(),
              );
            }
          : undefined,
        ensureWriter: runtime
          ? async (session) => {
              dismissPendingInteractions(session.id, new Date().toISOString());
              return runtime.ensureWriter(
                await recoverExecutionPolicy(session),
                new Date().toISOString(),
              );
            }
          : undefined,
        releaseWriter: runtime
          ? (id) => {
              dismissPendingInteractions(id, new Date().toISOString());
              return runtime.release(id);
            }
          : undefined,
        onTurnStarted: (session) => {
          activity.observe({
            sessionId: session.id,
            occurredAt: session.updatedAt,
            kind: 'turnStarted',
            ...(session.threadId ? { threadId: session.threadId } : {}),
            ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
          });
          planMeasurementRefresh?.refreshNow(session.id);
        },
        agentActivity: (id) => activity.snapshot(id, new Date().toISOString()),
        autopilotSnapshot: (id) => autopilot.snapshot(id),
        autopilotControlTurns: (id) => autopilot.acceptedControlTurns(id),
        autopilotAudit: (id, limit) => journal.autopilotAuditTail(id, limit),
        refreshActivity: (id) => activity.refresh(id),
        models,
        readHistory: runtime ? (session) => runtime.readHistory(session) : undefined,
        currentSequence: (sessionId) => journal.since(sessionId, 0).at(-1)?.sequence ?? 0,
        activityHistory: (sessionId, throughSequence) =>
          journal.since(sessionId, 0).filter((event) => event.sequence <= throughSequence),
        interruptTurn: runtime
          ? (session, turnId) => runtime.interruptTurn(session, turnId)
          : undefined,
        queueTurnInput: runtime
          ? (session, turnId, text, clientUserMessageId) => {
              autopilot.manualSend(session.id);
              return runtime.queueTurnInput(session, turnId, text, clientUserMessageId);
            }
          : undefined,
        restore: runtime
          ? async (session) => {
              const restored = await runtime.restoreWithOutcome(
                await recoverExecutionPolicy(session),
                new Date().toISOString(),
              );
              // An exit can be reported while resume is resolving. Do not let the
              // route persist a stale ready snapshot over that recovered exit.
              if (!runtime.ownsWriter(session.id))
                return {
                  ...restored,
                  session: RelaySession.rehydrate(restored.session).stop(new Date().toISOString())
                    .snapshot,
                };
              return restored;
            }
          : undefined,
        ownsWriter: runtime ? (id) => runtime.ownsWriter(id) : undefined,
        promoteRecent: runtime
          ? (thread) =>
              promoteRecentThread(thread, {
                createId: randomUUID,
                now: () => new Date().toISOString(),
                list: () => sessions.list(),
                save: saveSession,
                read: (session) => runtime.readHistory(session),
                executionPolicy: (candidate) => recentThreads.executionPolicy(candidate.id),
              })
          : undefined,
        release: (session) => {
          autopilot.cancel(session.id, 'sessionEnded');
          return RelaySession.rehydrate(session).release(new Date().toISOString()).snapshot;
        },
        remove: (id) => {
          autopilot.cancel(id, 'sessionEnded');
          activity.dispose(id);
          sessions.remove(id);
        },
        idempotency,
        close: runtime
          ? (id) => {
              autopilot.cancel(id, 'sessionEnded');
              planMeasurementRefresh?.stop(id);
              dismissPendingInteractions(id, new Date().toISOString());
              activity.dispose(id);
              return runtime.release(id);
            }
          : undefined,
        replyInteraction: runtime
          ? (sessionId, requestId, value) =>
              runtime.resolveServerRequest(sessionId, requestId, value) ? 'accepted' : 'cleared'
          : undefined,
        interactionResolved: (sessionId, requestId, occurredAt, outcome) => {
          const remaining = interactions.list(sessionId);
          const attention = remaining.find((item) => item.kind === 'orgPlanAttention');
          activity.observe({
            sessionId,
            occurredAt,
            kind: 'interactionResolved',
            hasPendingInteraction: remaining.length > 0,
            ...(attention
              ? { attentionReason: (attention.payload as OrgPlanAttention).reason }
              : {}),
          });
          publishInteractionResolved(sessionId, requestId, occurredAt, outcome);
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
        refresh: async (id) => {
          const refreshed = await planStatusSource.refresh(id);
          if (refreshed?.kind === 'updated') return refreshed.plan;
          return refreshed ? null : supervisedPlans.find(id);
        },
        open: async (id, planName) => {
          const session = sessions.find(id);
          if (!session) return { kind: 'missing' };
          const result = await workspacePlanCatalog.read(session.workspacePath, planName);
          if (result.kind === 'available') {
            const planPath = resolve(session.workspacePath, ...planName.split('/'));
            acceptPlanUpdate(id, {
              kind: 'updated',
              plan: result.plan,
              identity: createHash('sha256').update(planPath).digest('hex'),
              planPath,
              reason: 'supervision-start',
            });
          }
          return result;
        },
        removeStatus: (id) =>
          planStatusSource.remove(id, supervisedPlans.identity(id) ?? undefined),
        clear: (id) => supervisedPlans.clear(id),
        closed: (id) => {
          autopilot.cancel(id, 'planRemoved');
          planMeasurementRefresh?.stop(id);
          const occurredAt = new Date().toISOString();
          events.publish(journal.append(id, 'plan.closed', {}, occurredAt));
        },
      },
      workspacePlanRoutes: { workspaces, plans: workspacePlanCatalog },
      workspaceFileRoutes: { workspaces, files: workspaceFiles },
      autopilot,
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
          // Attention must use its operation-keyed boundary; generic interaction
          // responses deliberately cannot bypass durable operation identity.
          if (interaction.kind === 'orgPlanAttention') return false;
          return isValidInteractionResponse(interaction.kind, value);
        },
      },
      orgPlanAttention: {
        exists: (id) => sessions.find(id) !== null,
        reader: {
          active: (sessionId) => {
            const interaction = interactions
              .list(sessionId)
              .find((item) => item.kind === 'orgPlanAttention');
            const attention = interaction ? parseOrgPlanAttention(interaction.payload) : null;
            return interaction && attention
              ? {
                  requestId: interaction.requestId,
                  turnId: interaction.turnId ?? null,
                  requestedAt: interaction.requestedAt ?? null,
                  attention,
                }
              : null;
          },
        },
        resolver: {
          resolve: async ({ sessionId, requestId, operationKey, response }) => {
            const scope = `org-plan-attention:${sessionId}:${requestId}`;
            const stored = idempotency.get(scope, operationKey);
            if (stored) return JSON.parse(stored.body) as { kind: 'replayed'; resolvedAt: string };
            const terminal = interactions.terminalOperation(sessionId, requestId);
            if (terminal)
              return terminal.operationKey === operationKey
                ? terminal.outcome === 'failed'
                  ? { kind: 'writerCleared' as const, resolvedAt: terminal.resolvedAt }
                  : { kind: 'replayed' as const, resolvedAt: terminal.resolvedAt }
                : { kind: 'staleOperation' as const };
            const key = `${scope}:${operationKey}`;
            const inFlight = attentionResolutionOperations.get(key);
            if (inFlight) return inFlight;
            const operation = (async () => {
              const interaction = interactions.find(sessionId, requestId);
              if (!interaction || interaction.kind !== 'orgPlanAttention')
                return { kind: 'noActive' as const };
              const claim = interactions.claimOperation(sessionId, requestId, operationKey);
              if (claim === 'resolved') {
                const resolved = interactions.resolved(sessionId, requestId);
                return resolved
                  ? { kind: 'replayed' as const, resolvedAt: resolved.resolvedAt }
                  : { kind: 'staleOperation' as const };
              }
              if (claim === 'stale') return { kind: 'staleOperation' as const };
              if (claim === 'missing') return { kind: 'noActive' as const };
              // A durable capability belongs to the session/thread, not the
              // relay process.  A supported stopped writer is retryable;
              // missing capability identifies a pre-rollout legacy thread.
              if (sessions.find(sessionId)?.attentionToolCapability !== 'supported')
                return { kind: 'legacyUnsupported' as const };
              if (!runtime) return { kind: 'writerUnavailable' as const };
              if (!interactions.beginDelivery(sessionId, requestId, operationKey))
                return { kind: 'staleOperation' as const };
              const writer = runtime.attentionWriterState(sessionId, requestId);
              if (writer === 'unavailable') {
                interactions.retryDelivery(sessionId, requestId, operationKey);
                return { kind: 'writerUnavailable' as const };
              }
              const resolvedAt = new Date().toISOString();
              if (writer === 'cleared') {
                if (
                  !interactions.settleOperation(
                    sessionId,
                    requestId,
                    operationKey,
                    resolvedAt,
                    'failed',
                  )
                )
                  return { kind: 'staleOperation' as const };
                publishAttentionSettlement(sessionId, requestId, resolvedAt, 'failed');
                return { kind: 'writerCleared' as const, resolvedAt };
              }
              if (!runtime.resolveServerRequest(sessionId, requestId, response)) {
                // The state check and delivery are synchronous, but retain a
                // defensive retry path for a future runtime implementation.
                interactions.retryDelivery(sessionId, requestId, operationKey);
                return { kind: 'writerUnavailable' as const };
              }
              if (
                !interactions.settleOperation(
                  sessionId,
                  requestId,
                  operationKey,
                  resolvedAt,
                  'answered',
                )
              )
                return { kind: 'staleOperation' as const };
              const accepted = { kind: 'accepted' as const, resolvedAt };
              idempotency.put(
                scope,
                operationKey,
                202,
                JSON.stringify({ kind: 'replayed', resolvedAt }),
              );
              publishAttentionSettlement(sessionId, requestId, resolvedAt, 'answered');
              return accepted;
            })();
            attentionResolutionOperations.set(key, operation);
            try {
              return await operation;
            } finally {
              attentionResolutionOperations.delete(key);
            }
          },
        },
        transitions: attentionTransitions,
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
      sessions
        .list()
        .filter((session) => persistedSessionIds.has(session.id) && session.threadId !== null),
      2,
      async (session) => {
        // The status lease must repopulate the authoritative plan projection before
        // a durable coordinator is restored. Writer detachment is a process concern,
        // not a human disable: a later fenced continuation can reacquire it safely.
        if (session.desiredState === 'active') {
          saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
          await runtime?.release(session.id);
        }
        await runtime?.watchPlanStatus(session);
        autopilot.restore(session.id);
      },
    );
  };
  app.addHook('onListen', async () => {
    const profile = (await options.profiles.list()).find((item) => item.state === 'ok')?.name;
    if (profile) await editorSkillCatalog.refresh(profile, root);
    await detachActiveSessions();
  });
  app.addHook('onClose', async () => {
    closing = true;
    planMeasurementRefresh?.stopAll();
    for (const session of sessions.list()) {
      autopilot.dispose(session.id);
      activity.dispose(session.id);
      // Relay shutdown only releases this process's writer.  A typed attention
      // request remains a durable human-visible blocker for the next relay
      // instance; only an app-server-cleared request is a failed audit outcome.
      for (const interaction of interactions.list(session.id)) {
        if (interaction.kind === 'orgPlanAttention') continue;
        const occurredAt = new Date().toISOString();
        if (interactions.resolve(session.id, interaction.requestId, occurredAt, 'dismissed'))
          publishInteractionResolved(session.id, interaction.requestId, occurredAt, 'dismissed');
      }
    }
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
