/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { FilesystemSessionDefaults } from './platform/persistence/filesystem-session-defaults.js';
import { SessionModelConfig } from './platform/codex/session-model-config.js';
import { basename, dirname, join, resolve } from 'node:path';
import { debuglog } from 'node:util';

import { SqliteTransportDiagnostics } from './platform/persistence/sqlite-transport-diagnostics.js';
import { buildApp } from './app.js';
import { ManagedUpgrade } from './platform/maintenance/managed-upgrade.js';
import { LocalHostTestRunner } from './platform/host-tests/runner.js';
import { FilesystemSessionScratch } from './platform/scratch/filesystem-session-scratch.js';
import { FilesystemScratchCleanup } from './platform/scratch/filesystem-scratch-cleanup.js';
import { ForgetSession } from './features/sessions/forget-session/use-case.js';
import { SqliteForgetOperationStore } from './platform/persistence/sqlite-forget-operation-store.js';
import { CleanSessionScratch } from './features/sessions/clean-tmp/use-case.js';
import {
  withHistoryScratchContainment,
  withScratchContainment,
} from './platform/scratch/containment-fence.js';
import { loadWorkspaceHostTestConfig, within } from './platform/host-tests/config.js';
import { handleHostTestTool } from './features/host-tests/application/handle-tool.js';
import { gestaltTestRunnerDynamicTool } from '../shared/contracts/host-tests.js';
import { SelfDebugWorkspace } from './platform/self-debug/workspace.js';
import {
  createSelfDebugSession,
  debugExecutionSettings,
} from './features/self-debug/create-session.js';
import { startSession } from './features/sessions/start-session/use-case.js';
import {
  createStartTurn,
  readAcceptedTurn,
  type StartTurnDependencies,
} from './features/sessions/start-turn/use-case.js';
import type { ModelCatalog, ProfileCatalog } from './features/catalog/application/ports.js';
import { FilesystemWorkspaceCatalog } from './platform/catalog/filesystem-workspace-catalog.js';
import { FilesystemWorkspaceFiles } from './platform/filesystem/filesystem-workspace-files.js';
import { protocolCompatibility } from './platform/codex/protocol-compatibility.js';
import { launchCodexAppServer } from './platform/codex/codex-process-launcher.js';
import { CodexModelCatalog } from './platform/codex/codex-model-catalog.js';
import { CodexAllowanceReader } from './platform/codex/codex-allowance.js';
import { ProviderModelCatalog } from './platform/catalog/provider-model-catalog.js';
import { createRecentThreadLister } from './platform/codex/recent-thread-lister.js';
import { CodexSessionRuntime, type AppServer } from './platform/codex/session-runtime.js';
import { normalizeCodexNotification } from './platform/codex/normalizer.js';
import { decodeCodexFailure } from './platform/codex/codex-failure.js';
import { providerContinuationPrompt } from '../shared/contracts/provider-failure.js';
import { SessionProviderRecovery } from './features/sessions/application/provider-recovery.js';
import { parseMcpStartupStatus } from '../shared/contracts/mcp-startup-failure.js';
import { KimiSessionRuntime } from './platform/kimi/kimi-session-runtime.js';
import { KimiWebServerManager } from './platform/kimi/kimi-web-server-manager.js';
import { KimiModelCatalog } from './platform/kimi/kimi-model-catalog.js';
import { KimiSkillCatalog } from './platform/kimi/kimi-skill-catalog.js';
import { createKimiRecentSessionLister } from './platform/kimi/kimi-recent-session-lister.js';
import { kimiStateBase } from './platform/kimi/kimi-share-dir.js';
import { normalizeKimiEvent } from './platform/kimi/kimi-normalizer.js';
import { decodeKimiActivityFacts } from './platform/kimi/kimi-activity-facts.js';
import { isMissingCodexThreadRollout } from './platform/codex/json-rpc-client.js';
import { migrate } from './platform/persistence/migrate.js';
import { openRelayDatabase } from './platform/persistence/sqlite.js';
import { SqliteAuthorizationStore } from './platform/auth/sqlite-authorization-store.js';
import { SimpleWebAuthnAdapter } from './platform/auth/simple-webauthn-adapter.js';
import type { WebAuthnCeremonyService } from './features/auth/application/ports.js';
import { authorizationSessionId, authorizedDeviceId } from './features/auth/domain/identifiers.js';
import { SqliteSessionRepository } from './platform/persistence/sqlite-session-repository.js';
import { SqliteWorkspaceLifecycle } from './platform/persistence/sqlite-workspace-lifecycle.js';
import { FilesystemWorkspaceForget } from './platform/scratch/filesystem-workspace-forget.js';
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
  type PendingInteraction,
  type RelaySessionSnapshot,
} from './features/sessions/model/relay-session.js';
import {
  AgentActivityRegistry,
  type ActivityReconcileDiagnostic,
} from './features/agent-activity/registry.js';
import { SupervisionTakeover } from './features/autopilot/application/takeover-supervision.js';
import { SqliteSupervisionTakeoverStore } from './platform/persistence/sqlite-supervision-takeover-store.js';
import { SqliteRuntimeReleaseStore } from './platform/persistence/sqlite-runtime-release-store.js';
import { isOrgPlanTakeoverCall } from '../shared/contracts/org-plan-takeover.js';
import { WriterAcquisitionError } from './features/sessions/application/writer-acquisition.js';
import { toAgentActivityDto } from './features/agent-activity/activity-dto.js';
import {
  decodeAgentActivityFacts,
  decodeToolEfficiencyFacts,
} from './platform/codex/activity-facts.js';
import { ToolEfficiencyProjection } from './features/agent-activity/tool-efficiency-projection.js';
import { SqliteToolEfficiencyStore } from './platform/persistence/sqlite-tool-efficiency-store.js';
import {
  completedCommandId,
  compactOrgPlanCheckpointKind,
  isAgentCapacityRecoveryCall,
  isAutopilotWaitLeaseCall,
  resolvedServerRequestId,
  toPendingInteraction,
} from './platform/codex/server-request.js';
import { toOrgPlanCheckpointToolResponse } from '../shared/contracts/org-plan-checkpoint.js';
import { CheckpointCoordination } from './features/org-plan-checkpoint/application/coordinate.js';
import {
  isValidInteractionResponse,
  isValidQuizInteractionResponse,
} from './features/sessions/interaction/response-validator.js';
import { promoteRecentThread } from './features/sessions/promote-recent-thread/use-case.js';
import { FilesystemSkillProfileStore } from './platform/skills/filesystem-skill-profile-store.js';
import { CodexSkillCatalog } from './platform/skills/codex-skill-catalog.js';
import { CachedSkillCatalog } from './platform/skills/cached-skill-catalog.js';
import { ManagedSkillProvenance } from './platform/skills/managed-skill-provenance.js';
import { ManagedSkillCatalog } from './platform/skills/managed-skill-catalog.js';
import { VerifiedSkillCatalog } from './platform/skills/verified-skill-catalog.js';
import { CodexSerena } from './platform/codex/codex-serena.js';
import { ManagedSerena } from './platform/codex/managed-serena.js';
import { CodexCapabilities } from './platform/codex/codex-capabilities.js';
import { CodexPlaywright, type PlaywrightAuthority } from './platform/codex/codex-playwright.js';
import { ManagedPlaywright } from './platform/codex/managed-playwright.js';
import { isManagedPlaywrightCall } from '../shared/contracts/managed-playwright.js';
import { compileSkillOverride, type SkillProfile } from './features/skills/model/skill-profile.js';
import { SupervisedPlanRegistry } from './features/plans/application/supervised-plan-registry.js';
import { planAttachmentSupervision } from './features/plans/application/plan-attachment-supervision.js';
import { prepareOrgPlanSupervision } from './features/plans/application/prepare-org-plan-supervision.js';
import {
  startOrgPlanSupervision,
  OrgPlanSessionNotPublished,
} from './features/plans/application/start-org-plan-supervision.js';
import { SqliteOrgPlanLaunchStore } from './platform/persistence/sqlite-org-plan-launch-store.js';
import { resolveSessionSkillSelection } from './features/sessions/application/resolve-session-skills.js';
import { prepareOrgPlanSettings } from './features/plans/application/prepare-org-plan-settings.js';
import type { PlanStatusUpdate } from './features/plans/application/ports.js';
import { FilesystemPlanStatusSource } from './platform/plans/filesystem-plan-status-source.js';
import { FilesystemWorkspacePlanCatalog } from './platform/plans/filesystem-workspace-plan-catalog.js';
import { FilesystemOrgPlanContext } from './platform/plans/filesystem-org-plan-context.js';
import { FilesystemPlanArchiver } from './platform/plans/filesystem-plan-archiver.js';
import { checkpointPlanMeasurement } from './platform/plans/plan-measurement-command.js';
import { PlanMeasurementRefresh } from './platform/plans/plan-measurement-refresh.js';
import { SqliteAutopilotStore } from './platform/persistence/sqlite-autopilot-store.js';
import { AutopilotCoordinator } from './features/autopilot/application/service.js';
import { deriveSessionStatus } from './features/sessions/session-status.js';
import {
  AUTOPILOT_CONTINUATION_PROMPT,
  AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT,
  autopilotExecutorLaunchPrompt,
  defaultAutopilotPolicy,
} from './features/autopilot/application/policy.js';
import { createRelyingPartyConfig, type RelyingPartyConfig } from './config.js';
import type { SafeInteractionOutcome } from '../shared/contracts/chat-snapshot.js';
import type { OrgPlanAttention } from '../shared/contracts/org-plan-attention.js';
import {
  parseOrgPlanAttention,
  toOrgPlanAttentionAcknowledgement,
} from '../shared/contracts/org-plan-attention.js';
import {
  autopilotWaitLeaseToolResponse,
  type AutopilotWaitLease,
} from '../shared/contracts/autopilot-wait-lease.js';
import { agentCapacityRecoveryToolResponse } from '../shared/contracts/agent-capacity-recovery.js';
import {
  isOrgPlanHealthCall,
  parseOrgPlanHealthArguments,
} from '../shared/contracts/org-plan-health.js';
import {
  compactSupervisionSnapshot,
  SupervisionSnapshots,
} from './features/autopilot/application/supervision-snapshot.js';
import { ExecutorModelEvidenceReader } from './features/plans/application/executor-model-evidence.js';
import { ExecutorLaunchValidationReader } from './features/plans/application/executor-launch-validation.js';
import {
  assessModelPolicyAdmission,
  requireModelPolicyAdmission,
} from './features/plans/domain/model-policy-admission.js';
import { currentExecutableL1Index } from './features/plans/domain/supervised-plan.js';
import { AttentionResolution } from './features/org-plan-attention/application/resolve.js';
import { AttentionAcknowledgement } from './features/org-plan-attention/application/acknowledgement.js';
import type { OrgPlanAttentionTransitions } from './features/org-plan-attention/application/ports.js';
import type { ComponentVersion } from '../shared/contracts/component-version.js';
import type { LlmProvider, ProviderAvailability } from '../shared/contracts/llm-provider.js';
import { pwaIconUrl, type PwaIcon } from './features/pwa/register-routes.js';

const checkpointDiagnostic = debuglog('gestalt-mobile:checkpoint');
const attentionDiagnostic = debuglog('gestalt-mobile:attention');

export type ComposeRelayAppOptions = {
  root: string;
  dataDir?: string;
  /** Canonical, configuration-derived WebAuthn contract; never request-derived. */
  relyingParty: RelyingPartyConfig;
  passkeyAuthEnabled?: boolean;
  staticDir?: string;
  pwaIcon?: PwaIcon;
  testRunnerEnabled?: boolean;
  profiles: ProfileCatalog;
  installedCodexVersion: string | null;
  installedKimiVersion?: string | null;
  componentVersions?: readonly ComponentVersion[];
  startAppServers?: boolean;
  activityDiagnostic?: (
    sessionId: string,
    code: 'reconcileExhausted',
    detail?: ActivityReconcileDiagnostic,
  ) => void;
  activitySchedule?: (callback: () => void, delayMs: number) => () => void;
  /** Test-only deterministic seam around the production coordinator timer. */
  autopilotSchedule?: (callback: () => void, delayMs: number) => () => void;
  /** Test-only bounded checkpoint response-write deadline. */
  checkpointHandoffDeadlineMs?: number;
  attentionAcknowledgementDeadlineMs?: number;
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
    environment?: Readonly<Record<string, string>>;
  }) => AppServer;
  /** Test-only explicit-session model resolver; production uses provider runtimes below. */
  sessionModelCatalog?: ModelCatalog;
  /** Test seam; production constructs the manager when the kimi CLI is installed. */
  kimiServerManager?: KimiWebServerManager;
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
  let hostTests: LocalHostTestRunner | undefined;
  const supervisionSnapshots = new SupervisionSnapshots();
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
  const sessions = new SqliteSessionRepository(database, new SqliteWorkspaceLifecycle(database));
  const forgetOperations = new SqliteForgetOperationStore(database);
  // Only sessions found while opening the relay database belong to a previous
  // process. A listen hook can run after a new session has already started in
  // this process; detaching that live writer would make restore and activity
  // reconciliation race their own owner.
  const persistedSessionIds = new Set(sessions.list().map((session) => session.id));
  const journal = new SqliteEventJournal(database);
  const toolEfficiency = new ToolEfficiencyProjection(new SqliteToolEfficiencyStore(database));
  const interactions = new SqlitePendingInteractionStore(database);
  const idempotency = new SqliteIdempotencyStore(database);
  const orgPlanLaunches = new SqliteOrgPlanLaunchStore(database);
  // Admission spans asynchronous provider calls so Execute cannot reserve a workspace mid-start.
  const workspaceAdmissions = new Map<string, number>();
  const assertWorkspaceOwner = (session: Pick<RelaySessionSnapshot, 'id' | 'workspacePath'>) => {
    let owner = orgPlanLaunches.workspaceOwner(session.workspacePath);
    while (
      owner &&
      forgetOperations.find(owner.sessionId)?.phase === 'completed' &&
      !sessions.find(owner.sessionId) &&
      !runtime?.ownsWriter(owner.sessionId)
    ) {
      orgPlanLaunches.releaseOwner(owner);
      owner = orgPlanLaunches.workspaceOwner(session.workspacePath);
    }
    if (owner && owner.sessionId !== session.id)
      throw new WriterAcquisitionError('workspaceLocked');
  };
  const withWorkspaceAdmission = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const session = sessions.find(sessionId);
    if (session) assertWorkspaceOwner(session);
    workspaceAdmissions.set(sessionId, (workspaceAdmissions.get(sessionId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = (workspaceAdmissions.get(sessionId) ?? 1) - 1;
      if (count) workspaceAdmissions.set(sessionId, count);
      else workspaceAdmissions.delete(sessionId);
    }
  };
  const reconcileOrgPlanReceipt = (sessionId: string) => {
    const record = orgPlanLaunches.forSession(sessionId);
    if (record?.phase !== 'submitting' || !record.bootstrapFingerprint) return;
    const receipt = readAcceptedTurn(
      idempotency,
      sessionId,
      `org-plan-bootstrap:${record.launchId}`,
      record.bootstrapFingerprint,
    );
    if (receipt?.activeTurnId)
      orgPlanLaunches.save(
        {
          ...record,
          phase: 'accepted',
          bootstrap: {
            kind: 'accepted',
            requestId: `org-plan-bootstrap:${record.launchId}`,
            turnId: receipt.activeTurnId,
          },
        },
        'submitting',
      );
  };
  const autopilotStore = new SqliteAutopilotStore(database);
  const takeoverStore = new SqliteSupervisionTakeoverStore(database, autopilotStore);
  const supervisedPlans = new SupervisedPlanRegistry();
  const supervisorOwnership = (sessionId: string): 'owned' | 'replaced' | 'transferring' => {
    const identity =
      supervisedPlans.identity(sessionId) ?? autopilotStore.find(sessionId)?.planIdentity;
    const owner = identity ? takeoverStore.owner(identity) : null;
    if (identity && owner?.sessionId !== sessionId && takeoverStore.retired(identity, sessionId))
      return 'replaced';
    const path = sessions.find(sessionId)?.lastOrgPlan?.path;
    const launchOwner = path ? orgPlanLaunches.owner(path) : null;
    if (!owner && launchOwner && launchOwner.sessionId !== sessionId) return 'transferring';
    return !owner
      ? 'owned'
      : owner.sessionId !== sessionId
        ? identity && takeoverStore.retired(identity, sessionId)
          ? 'replaced'
          : 'transferring'
        : owner.phase === 'stopping'
          ? 'transferring'
          : 'owned';
  };
  const requireOrgExecutionAdmission = (sessionId: string) =>
    requireModelPolicyAdmission(
      supervisedPlans.find(sessionId),
      supervisedPlans.modelPolicyStatus(sessionId),
    );
  const planStatusSource = new FilesystemPlanStatusSource(join(dirname(databasePath), 'plans'));
  const planMeasurementHelperPath =
    options.planMeasurementHelperPath ?? process.env.GESTALT_MOBILE_ORG_PLAN_HELPER;
  const pendingInteractionsWithReports = (sessionId: string) =>
    interactions.list(sessionId).map((interaction) => ({
      ...interaction,
      ...(interaction.kind === 'orgPlanAttention' && interaction.turnId && interaction.requestedAt
        ? {
            supervisorReport:
              interactions.attentionReport(sessionId, interaction.requestId) ??
              journal.attentionReport(sessionId, interaction.turnId, interaction.requestedAt),
          }
        : {}),
    }));
  const withPendingInteractions = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null,
  ) =>
    session
      ? { ...session, pendingInteractions: pendingInteractionsWithReports(session.id) }
      : null;
  // A quiz outlives its dynamic-tool request so a late answer can be delivered
  // as a follow-up. Once its owning turn ends, it is no longer a runtime wait.
  // Approvals and durable Org attention retain their independent blocking role.
  const blockingInteractions = (sessionId: string) => {
    const activeTurnId = sessions.find(sessionId)?.activeTurnId;
    return interactions
      .list(sessionId)
      .filter(
        (interaction) =>
          interaction.kind !== 'quiz' || !interaction.turnId || interaction.turnId === activeTurnId,
      );
  };
  const events = new SessionEventBus();
  let notifyAutopilotActivity: (sessionId: string) => void = () => undefined;
  let publishSessionStatus: (sessionId: string, occurredAt: string) => void = () => undefined;
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
    (snapshot, occurredAt, kind) => {
      events.publish(
        journal.append(
          snapshot.sessionId,
          'agent.activity.updated',
          {
            ...toAgentActivityDto(snapshot),
            ...(autopilotStore.find(snapshot.sessionId)?.checkpoints?.activeHandoffId
              ? {
                  traceId: autopilotStore.find(snapshot.sessionId)!.checkpoints!.activeHandoffId,
                }
              : {}),
          },
          occurredAt,
        ),
      );
      if (kind !== 'progress') {
        publishSessionStatus(snapshot.sessionId, occurredAt);
        notifyAutopilotActivity(snapshot.sessionId);
      }
    },
    {
      rootThreadId: (sessionId) => sessions.find(sessionId)?.threadId ?? null,
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
        ((sessionId, code, detail) =>
          console.warn(
            `agent activity ${code} session=${sessionId} attempt=${detail?.attempt ?? 0} rpcCode=${detail?.rpcCode ?? 'none'} errorCode=${detail?.errorCode ?? 'none'}`,
          )),
      reconcile: async (sessionId) => {
        const session = sessions.find(sessionId);
        if (!session) return false;
        // Kimi sessions own no child-process projection; one detached history
        // read supplies the whole reconciliation, mirroring the codex tail.
        if (session.provider === 'kimi') {
          if (!kimiRuntime) return false;
          const history = await kimiRuntime.readHistory(session);
          // Forget may commit while the detached history reader is still in
          // flight. Revalidate ownership before handing its result to the
          // registry, whose publisher intentionally keeps the journal strict.
          if (!sessions.find(sessionId)) return false;
          const occurredAt = new Date().toISOString();
          activity.observe({
            sessionId,
            occurredAt,
            kind: history.activeTurnId ? 'turnStarted' : 'turnCompleted',
            ...(session.threadId ? { threadId: session.threadId } : {}),
            ...(history.activeTurnId ? { turnId: history.activeTurnId } : {}),
          });
          return true;
        }
        if (!runtime) return false;
        const rootActivity = await runtime.readActivity(session);
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
        if (!sessions.find(sessionId)) return false;
        // Publish only after the entire authoritative read succeeds. A fresh
        // root with stale child topology is not a valid supervision snapshot.
        const occurredAt = new Date().toISOString();
        activity.observe({
          sessionId,
          occurredAt,
          kind: rootActivity.active ? 'turnStarted' : 'turnCompleted',
          ...(session.threadId ? { threadId: session.threadId } : {}),
        });
        activity.childrenReconciled(
          sessionId,
          occurredAt,
          children.map((child) => ({
            ...child,
            processes: childProcesses.get(child.id) ?? [],
          })),
        );
        return true;
      },
    },
  );
  let ordinaryTurnPending: (sessionId: string) => boolean = () => false;
  const pendingRootTurn = (sessionId: string) =>
    ordinaryTurnPending(sessionId) ||
    (orgPlanLaunches.forSession(sessionId)?.phase === 'submitting' &&
      !orgPlanLaunches.forSession(sessionId)?.manualRecoveryTurnId);
  const autopilot = new AutopilotCoordinator({
    supervisorOwnership,
    pendingProcessResult: (sessionId) => hostTests?.hasUnreadResult(sessionId) ?? false,
    processResultState: (sessionId, runId) => hostTests?.resultState(sessionId, runId) ?? 'missing',
    modelPolicyStatus: (sessionId) => supervisedPlans.modelPolicyStatus(sessionId),
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
    pendingInteraction: (sessionId) => blockingInteractions(sessionId).length > 0,
    pendingTurn: pendingRootTurn,
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
      start: async (sessionId, controlId, generation, launchIdentity) =>
        withWorkspaceAdmission(sessionId, async () => {
          if (supervisorOwnership(sessionId) !== 'owned')
            throw new Error('AUTOPILOT_START_UNAVAILABLE');
          const current = () => {
            const state = autopilotStore.find(sessionId);
            return Boolean(
              state &&
              !pendingRootTurn(sessionId) &&
              state.requestedEnabled &&
              state.generation === generation &&
              state.lastControlId === controlId,
            );
          };
          if (!current()) throw new Error('AUTOPILOT_START_UNAVAILABLE');
          const session = sessions.find(sessionId);
          if (
            !session ||
            !runtime ||
            session.activeTurnId ||
            blockingInteractions(sessionId).length
          )
            throw new Error('AUTOPILOT_START_UNAVAILABLE');
          requireOrgExecutionAdmission(sessionId);
          if (
            !current() ||
            sessions.find(sessionId)?.activeTurnId ||
            blockingInteractions(sessionId).length
          )
            throw new Error('AUTOPILOT_START_UNAVAILABLE');
          // A relay restart can leave a durable, otherwise eligible session without this
          // process's writer. Reacquire through the normal ownership boundary before a
          // synthetic start; never bypass its single-writer and replacement semantics.
          const writer = await runtime.ensureWriter(session, new Date().toISOString());
          if (!current() || writer.session.activeTurnId || blockingInteractions(sessionId).length)
            throw new Error('AUTOPILOT_START_UNAVAILABLE');
          const selectedPlan = supervisedPlans.find(sessionId);
          const selectedPlanFence = JSON.stringify(selectedPlan);
          const selectedPolicy =
            selectedPlan?.modelPolicyVersion === 1
              ? selectedPlan.steps[currentExecutableL1Index(selectedPlan)]?.modelPolicy
              : undefined;
          if (selectedPolicy) await runtime.validateExecutorPolicy(sessionId, selectedPolicy);
          await options.autopilotBeforeTurnAccepted?.({ sessionId, controlId });
          requireOrgExecutionAdmission(sessionId);
          if (
            !current() ||
            JSON.stringify(supervisedPlans.find(sessionId)) !== selectedPlanFence ||
            sessions.find(sessionId)?.activeTurnId ||
            blockingInteractions(sessionId).length
          )
            throw new Error('AUTOPILOT_START_UNAVAILABLE');
          const recovery = autopilotStore.find(sessionId);
          const continuationPrompt = recovery?.providerRetry?.resumeRoot
            ? providerContinuationPrompt
            : launchIdentity
              ? autopilotExecutorLaunchPrompt(launchIdentity, supervisedPlans.find(sessionId))
              : AUTOPILOT_CONTINUATION_PROMPT;
          const executorRecovery =
            recovery?.supervision?.outcome === 'probeRequired' &&
            recovery.executor?.commands?.some(
              (command) => command.status === 'issued' && !command.processAction,
            );
          const recoveryInstruction = executorRecovery
            ? ' The previous executor resume has an unconfirmed outcome. Inspect the existing canonical executor and its latest turn before continuing. Preserve its physical identity; do not replay an active turn or replace the executor merely because the resume reply failed. Resolve this probe with verified actionable work, a valid wait lease, or genuine structured attention.'
            : '';
          const started = await runtime.startTurn(
            writer.session,
            continuationPrompt + recoveryInstruction,
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
        }),
    },
    executorController: {
      resume: async (sessionId, threadId, generation, trigger) =>
        withWorkspaceAdmission(sessionId, async () => {
          if (supervisorOwnership(sessionId) !== 'owned')
            throw new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE');
          const session = sessions.find(sessionId);
          if (!session || !runtime || blockingInteractions(sessionId).length)
            throw new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE');
          requireOrgExecutionAdmission(sessionId);
          const writer = await runtime.ensureWriter(session, new Date().toISOString());
          if (blockingInteractions(sessionId).length)
            throw new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE');
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
          let turnId: string;
          try {
            turnId = await runtime.startExecutorTurn(
              writer.session,
              threadId,
              `${AUTOPILOT_EXECUTOR_CONTINUATION_PROMPT}${context}`,
              clientId,
            );
          } catch (error) {
            // A confirmed app-server missing-rollout response is a rejection;
            // transport loss remains ambiguous and must retain the issued fence.
            if (isMissingCodexThreadRollout(error)) throw new Error('AUTOPILOT_EXECUTOR_REJECTED');
            throw error;
          }
          activity.observe({
            sessionId,
            occurredAt: new Date().toISOString(),
            kind: 'turnStarted',
            threadId,
            turnId,
          });
        }),
      refresh: (sessionId) => activity.refresh(sessionId),
      interrupt: async (sessionId, threadId) => {
        const session = sessions.find(sessionId);
        return session && runtime ? runtime.interruptExecutor(session, threadId) : false;
      },
      transferProcess: (sessionId, threadId, processId, actionId) => {
        void actionId;
        activity.transferProcessOwnership(sessionId, threadId, processId, new Date().toISOString());
      },
      consumeProcess: (sessionId, threadId, processId, _actionId) => {
        runtime?.consumeChildProcessResult(sessionId, threadId, processId, _actionId);
      },
      terminateProcess: async (sessionId, threadId, processId, actionId, processInstance) => {
        const session = sessions.find(sessionId);
        return session && runtime
          ? runtime.terminateChildProcess(session, threadId, processId, actionId, processInstance)
          : false;
      },
    },
    publish: (sessionId, type, payload, occurredAt, outboxId) => {
      if (!sessions.find(sessionId)) return;
      events.publish(journal.append(sessionId, type, payload, occurredAt, outboxId));
    },
  });
  notifyAutopilotActivity = (sessionId) => autopilot.activityChanged(sessionId);
  publishSessionStatus = (sessionId, occurredAt) => {
    const session = sessions.find(sessionId);
    if (!session) return;
    events.publish(
      journal.append(
        sessionId,
        'session.status.updated',
        deriveSessionStatus({
          session,
          plan: supervisedPlans.find(sessionId),
          activity: activity.snapshot(sessionId, occurredAt),
          autopilot: autopilot.snapshot(sessionId),
          pendingAttention: blockingInteractions(sessionId).length > 0,
          observedAt: occurredAt,
        }),
        occurredAt,
      ),
    );
  };
  options.onAutopilotCoordinator?.(autopilot);
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const workspaceFiles = new FilesystemWorkspaceFiles();
  const debugHome = options.homeDirectory ?? homedir();
  const debugWorkspace = new SelfDebugWorkspace(
    join(debugHome, '.gestalt', 'self-debug'),
    join(process.env.CODEX_HOME ?? join(debugHome, '.codex'), 'agents', 'org-plan-executor.toml'),
    databasePath,
  );
  const homeDirectory = options.homeDirectory ?? homedir();
  const sessionScratch = new FilesystemSessionScratch(
    (id) => forgetOperations.assertAvailable(id),
    ({ id }) => {
      forgetOperations.assertAvailable(id);
      const current = sessions.find(id);
      if (!current) throw new Error('SESSION_NOT_FOUND');
      sessions.save(
        RelaySession.rehydrate(current).beginRecovery(new Date().toISOString()).snapshot,
        true,
      );
    },
  );
  // Constructing the manager is cheap (no spawn until `ensure`); building it
  // before the model catalog lets the catalog reuse the gestalt-owned servers.
  const kimiManager =
    options.kimiServerManager ??
    (options.installedKimiVersion != null && options.startAppServers
      ? new KimiWebServerManager({
          stateBase: kimiStateBase(homeDirectory),
          sourceShareDir: join(homeDirectory, '.kimi-code'),
          serviceScratch: (profileKey) =>
            sessionScratch.allocateService(root, `kimi-${profileKey}`),
        })
      : undefined);
  const kimiModels = new KimiModelCatalog(kimiManager ?? null, kimiManager != null);
  const models = new ProviderModelCatalog({
    codex:
      options.installedCodexVersion === null
        ? { list: async () => [] }
        : new CodexModelCatalog(root, options.launchAppServer ?? launchCodexAppServer),
    kimi: kimiModels,
  });
  const sessionModels: ModelCatalog = options.sessionModelCatalog ?? {
    list: (provider) => (provider === 'kimi' ? kimiModels.listForSession() : models.list(provider)),
  };
  const skillProfiles = new FilesystemSkillProfileStore(options.homeDirectory ?? homedir());
  const sessionDefaults = new FilesystemSessionDefaults(options.homeDirectory ?? homedir());
  const sessionModelConfig = new SessionModelConfig(
    process.env.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), '.codex-gestalt'),
    dirname(databasePath),
  );
  // kimi discovery is workspace-scoped, not profile-scoped: the profile only
  // decides which discovered skills a session's server materializes.
  const codexHome =
    process.env.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), '.codex-gestalt');
  const skillProvenance = new ManagedSkillProvenance(codexHome);
  const kimiSkillCatalog = new VerifiedSkillCatalog(
    new KimiSkillCatalog(
      kimiManager ?? null,
      kimiManager != null,
      new ManagedSkillCatalog(codexHome),
    ),
    skillProvenance,
  );
  const serenaInstallation = new ManagedSerena();
  const capabilities = new CodexCapabilities(new CodexSerena(serenaInstallation));
  const playwright = new CodexPlaywright(new ManagedPlaywright(), sessionScratch);
  const playwrightAuthority = (session: RelaySessionSnapshot): PlaywrightAuthority => {
    const plan = supervisedPlans.findCurrent(session.id);
    const active = plan?.steps[currentExecutableL1Index(plan)];
    const control = autopilotStore.find(session.id);
    return {
      session,
      planIdentity: supervisedPlans.identity(session.id),
      activePlanId: active?.id ?? null,
      declared: active?.state === 'WIP' && active.managedMcp?.includes('playwright') === true,
      fenced:
        control?.stopReason === 'manualDisabled' ||
        control?.state === 'safetyPaused' ||
        control?.state === 'attentionRequired' ||
        blockingInteractions(session.id).length > 0,
    };
  };
  const skillCatalog = (provider: LlmProvider, profile: string) =>
    provider === 'kimi'
      ? kimiSkillCatalog
      : new VerifiedSkillCatalog(
          new CodexSkillCatalog(profile, options.launchAppServer ?? launchCodexAppServer),
          skillProvenance,
        );
  const editorSkillCatalog = new CachedSkillCatalog(
    (provider, profile, workspace) =>
      provider === 'codex'
        ? new VerifiedSkillCatalog(
            new CodexSkillCatalog(
              profile,
              options.launchAppServer ?? launchCodexAppServer,
              5_000,
              capabilities,
            ),
            skillProvenance,
          ).list(workspace)
        : kimiSkillCatalog.list(workspace),
    async (provider, _profile, workspace, result) => {
      if (provider !== 'codex') return result;
      const serenaStatus = result.skills.some(
        (skill) => skill.name === 'gestalt:serena' && skill.enabled,
      )
        ? serenaInstallation.check()
        : undefined;
      const installedSerena = await serenaStatus;
      return {
        ...result,
        skills: result.skills.map((skill) =>
          skill.name === 'gestalt:serena' &&
          installedSerena &&
          installedSerena.status !== 'installed'
            ? { ...skill, enabled: false }
            : skill,
        ),
      };
    },
    skillProvenance,
  );
  const workspacePlanCatalog = new FilesystemWorkspacePlanCatalog();
  const orgPlanContext = new FilesystemOrgPlanContext(workspaces, (id) => sessions.find(id));
  const planArchiver = new FilesystemPlanArchiver();
  const resolveSkills = async (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
  ) => {
    const catalog =
      session.provider === 'kimi'
        ? await kimiSkillCatalog.list(session.workspacePath)
        : await skillCatalog('codex', session.profile).list(session.workspacePath);
    if (session.effectiveSkillSelection)
      return compileSkillOverride({
        discovered: catalog.skills,
        explicit: session.effectiveSkillSelection.skills,
      }).skillsConfig;
    const project = await skillProfiles.readWorkspaceDefault(session.workspacePath);
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
  const kimiRecentSessions = createKimiRecentSessionLister({
    servers: kimiManager ?? null,
    available: kimiManager != null,
  });
  // The relay's recent list spans both llm services; execution-policy metadata
  // stays a codex rollout concern, so the codex lister remains the source.
  const recentThreadsForRelay = {
    list: async (): Promise<
      import('./features/sessions/list-recent-threads/endpoint.js').RecentThread[]
    > => [...(await recentThreads.list()), ...(await kimiRecentSessions.list())],
  };
  const recoverExecutionPolicy = async (
    session: RelaySessionSnapshot,
  ): Promise<RelaySessionSnapshot> => {
    if (session.executionPolicy || !session.threadId) return session;
    const executionPolicy = await recentThreads.executionPolicy(session.threadId);
    return executionPolicy
      ? { ...session, executionPolicy, updatedAt: new Date().toISOString() }
      : session;
  };
  const protocol = protocolCompatibility(options.installedCodexVersion);
  const providerAvailability: ProviderAvailability = {
    codex: {
      available: options.installedCodexVersion !== null && protocol.compatible,
      ...(options.installedCodexVersion === null ? {} : { version: options.installedCodexVersion }),
    },
    kimi: {
      available: options.installedKimiVersion != null,
      ...(options.installedKimiVersion ? { version: options.installedKimiVersion } : {}),
    },
  };
  const gitFetches = new GitFetchCoordinator(fetchUpstream);
  const gitSummaries = new GitSummaryCache(inspectGit);
  let recoverExitedSession: (sessionId: string) => void = () => {};
  let recoverExitedKimiSession: (sessionId: string) => void = () => {};
  let scheduleAgentCapacityRecovery: (
    sessionId: string,
    acknowledge: () => boolean,
  ) => boolean = () => false;
  const capacityRecoveries = new Set<string>();
  const capacityRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const capacityRecoveryTasks = new Map<string, Promise<void>>();
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
    autopilot.semanticEvent(sessionId, 'interactionChanged');
    publishSessionStatus(sessionId, occurredAt);
  };
  const publishAttentionSettlement = (
    sessionId: string,
    requestId: string,
    occurredAt: string,
    outcome: Extract<SafeInteractionOutcome, 'answered' | 'failed'>,
  ) => {
    const remaining = blockingInteractions(sessionId);
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
      // Quiz answers remain useful after Codex clears the original dynamic-tool
      // request: the client can deliver them as a follow-up prompt instead.
      if (interaction.kind === 'quiz') continue;
      if (
        interaction.kind === 'orgPlanAttention' &&
        interactions.resolutionState(sessionId, interaction.requestId) === 'acknowledged'
      )
        continue;
      if (interactions.resolve(sessionId, interaction.requestId, occurredAt, outcome))
        publishInteractionResolved(sessionId, interaction.requestId, occurredAt, outcome);
    }
  };
  const checkpoints = new CheckpointCoordination({
    plans: {
      refresh: async (id) => (await planStatusSource.refresh(id))?.kind === 'updated',
      find: (id) => supervisedPlans.find(id),
      identity: (id) => supervisedPlans.identity(id),
      publicationReason: (id) => supervisedPlans.publicationReason(id),
      completedTargets: (id) =>
        autopilotStore
          .find(id)
          ?.checkpoints?.completionEpochs?.filter((epoch) => epoch.completed && !epoch.reopened)
          .map((epoch) => epoch.target),
      pendingTarget: (id) => autopilotStore.find(id)?.checkpoints?.pendingTarget,
    },
    activity: (id) => activity.snapshot(id, new Date().toISOString()),
    pending: {
      add: (id, interaction) => interactions.add(id, interaction),
      find: (id, requestId) => interactions.find(id, requestId),
      list: (id) => interactions.list(id),
      resolve: (id, requestId, at, outcome) => interactions.resolve(id, requestId, at, outcome),
    },
    autopilot: {
      accept: (id, checkpoint, turnId, at) =>
        autopilot.checkpointAccepted(id, checkpoint, turnId, at),
      failed: (id, turnId) => autopilot.checkpointHandoffFailed(id, turnId),
      recover: (id) => autopilot.recoverCheckpointHandoff(id),
    },
    writer: {
      resolve: (id, requestId, response) =>
        runtime?.resolveServerRequest(id, requestId, response) === true,
      reject: (id, requestId, error) => runtime?.rejectServerRequest(id, requestId, error),
      recovery: (id) => {
        const ownedRuntime = runtime;
        const session = sessions.find(id);
        if (!ownedRuntime || !session) return null;
        return {
          activeTurnId: session.activeTurnId,
          current: () => runtime === ownedRuntime,
          recycle: (at) => ownedRuntime.recycle(session, at),
        };
      },
    },
    currentTurn: (id) => sessions.find(id)?.activeTurnId,
    saveSession: (session) => saveSession(session),
    turnCompleted: (sessionId, occurredAt) =>
      activity.observe({ sessionId, occurredAt, kind: 'turnCompleted' }),
    publishFailure: (sessionId, requestId, occurredAt) => {
      events.publish(
        journal.append(
          sessionId,
          'org-plan.checkpoint-handoff-failed',
          {
            requestId,
            reason: 'checkpointHandoffFailed',
            ...(autopilotStore.find(sessionId)?.checkpoints?.activeHandoffId
              ? { traceId: autopilotStore.find(sessionId)!.checkpoints!.activeHandoffId }
              : {}),
          },
          occurredAt,
        ),
      );
    },
    publishSettlement: publishAttentionSettlement,
    failureResponse: checkpointFailureResponse,
    now: () => new Date().toISOString(),
    deadlineMs: options.checkpointHandoffDeadlineMs ?? 5_000,
    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    },
  });
  const attentionAcknowledgement = new AttentionAcknowledgement({
    deadlineMs: options.attentionAcknowledgementDeadlineMs ?? 5_000,
    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    },
    recoverWriter: (sessionId, requestId) => {
      const ownedRuntime = runtime;
      const session = sessions.find(sessionId);
      if (!ownedRuntime || !session || !ownedRuntime.abandonServerRequest(sessionId, requestId))
        return;
      void ownedRuntime
        .recycle(session, new Date().toISOString())
        .then((recovered) => saveSession(recovered))
        .catch(() => {
          // Durable attention survives; normal recovery can reacquire the writer.
        });
    },
  });
  let closing = false;
  let runtime: CodexSessionRuntime | null = null;
  const takeover = new SupervisionTakeover({
    store: takeoverStore,
    now: () => new Date().toISOString(),
    context: (id) => {
      const session = sessions.find(id);
      const plan = supervisedPlans.findCurrent(id);
      const identity = supervisedPlans.identity(id);
      if (!session || !plan || !identity) return null;
      return {
        session,
        plan,
        identity,
        state: autopilotStore.find(id),
        admission: autopilot.snapshot(id).executionAdmission?.allowed !== false,
        held: blockingInteractions(id).length > 0,
        localExecutor: activity
          .snapshot(id, new Date().toISOString())
          .subagents.some(
            (child) =>
              Boolean(child.canonicalPosition) ||
              ['working', 'awaitingAgent'].includes(child.state) ||
              child.ownedProcesses?.some((process) =>
                ['running', 'detached-active'].includes(process.state),
              ),
          ),
      };
    },
    predecessors: (context) =>
      sessions.list().flatMap((session) => {
        if (
          session.id === context.session.id ||
          session.workspacePath !== context.session.workspacePath ||
          session.provider !== 'codex'
        )
          return [];
        const state = autopilotStore.find(session.id);
        return state && state.planIdentity === context.identity ? [{ session, state }] : [];
      }),
    fence: (id) => autopilot.cancel(id, 'sessionEnded'),
    stop: async ({ session, state }) => {
      if (!runtime || (hostTests?.supervisionSummary(session.id).running ?? 0) > 0) return false;
      if (
        !(await runtime.quiesceForTakeover(
          session,
          state.executor?.ownedProcesses ?? [],
          state.executor,
        ))
      )
        return false;
      const latest = sessions.find(session.id);
      if (!latest || latest.threadId !== session.threadId) return false;
      dismissPendingInteractions(session.id, new Date().toISOString());
      const released = RelaySession.rehydrate(latest).release(new Date().toISOString()).snapshot;
      sessions.save(released);
      activity.disconnected(session.id, released.updatedAt);
      events.publish(journal.append(session.id, 'session.updated', released, released.updatedAt));
      return true;
    },
    changed: (id) => {
      autopilot.planStatusChanged(id);
      autopilot.restore(id);
    },
    failed: (sessionId, boundary) => {
      const now = new Date().toISOString();
      events.publish(
        journal.append(sessionId, 'autopilot.takeover-failed', { kind: boundary }, now),
      );
    },
  });
  const providerRecovery = new SessionProviderRecovery({
    find: (id) => sessions.find(id),
    authority: (id) => {
      const state = autopilotStore.find(id);
      if (
        closing ||
        !runtime?.ownsWriter(id) ||
        blockingInteractions(id).length ||
        (state && (state.requestedEnabled || state.state !== 'disabled'))
      )
        return null;
      // Idle observations can advance Autopilot's generation even while Off.
      // An explicit toggle/send clears this failure identity instead.
      return state?.providerFailureTurnId ?? 'no-failure';
    },
    reconcile: async (id) => {
      await activity.refresh(id);
      const snapshot = activity.snapshot(id, new Date().toISOString());
      return (
        snapshot.confidence === 'fresh' &&
        snapshot.root.state === 'idle' &&
        snapshot.subagents.every(
          (agent) =>
            agent.state === 'idle' &&
            !agent.ownedProcesses?.some((process) =>
              ['running', 'detached-active'].includes(process.state),
            ),
        )
      );
    },
    schedule:
      options.autopilotSchedule ??
      ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      }),
    start: async (session, current) =>
      withWorkspaceAdmission(session.id, async () => {
        if (!runtime || !current()) throw new Error('PROVIDER_RETRY_CANCELLED');
        const started = await runtime.startTurn(
          session,
          providerContinuationPrompt,
          `provider-retry-${randomUUID()}`,
          new Date().toISOString(),
          current,
        );
        saveSession(started);
        activity.observe({
          sessionId: started.id,
          occurredAt: started.updatedAt,
          kind: 'turnStarted',
          threadId: started.threadId!,
          turnId: started.activeTurnId!,
        });
      }),
    publish: (id, type, payload) => {
      events.publish(journal.append(id, type, payload, new Date().toISOString()));
    },
  });
  let kimiRuntime: KimiSessionRuntime | null = null;
  const executorPolicyContext = (sessionId: string) => {
    const session = sessions.find(sessionId);
    const plan = supervisedPlans.find(sessionId);
    if (!session || session.provider !== 'codex' || plan?.modelPolicyVersion !== 1) return null;
    return {
      sessionId,
      provider: session.provider,
      rootThreadId: session.threadId ?? null,
      planIdentity: supervisedPlans.identity(sessionId),
      modelPolicyStatus: supervisedPlans.modelPolicyStatus(sessionId),
      plan,
      executor: autopilotStore.find(sessionId)?.executor ?? null,
    };
  };
  const executorModelEvidence = new ExecutorModelEvidenceReader(executorPolicyContext, {
    read: (input) =>
      runtime?.readExecutorConfiguration(input) ??
      Promise.resolve({ kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' }),
  });
  const executorLaunchValidation = new ExecutorLaunchValidationReader(executorPolicyContext, {
    read: (input) =>
      runtime?.readExecutorPolicyCatalog(input) ??
      Promise.resolve({ kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' }),
  });
  /**
   * Shared acceptance path for a provider-neutral pending interaction: it
   * enters the durable store, requests human attention, and notifies autopilot.
   * Both the codex JSON-RPC handler and the kimi polling handler land here.
   */
  const acceptPendingInteraction = (
    sessionId: string,
    rawInteraction: PendingInteraction,
    session: RelaySessionSnapshot,
    acknowledgeAttention = false,
  ): boolean => {
    const interaction = {
      ...rawInteraction,
      turnId: session.activeTurnId,
      requestedAt: new Date().toISOString(),
    };
    interactions.add(
      sessionId,
      interaction,
      acknowledgeAttention && interaction.kind === 'orgPlanAttention' ? 'acknowledged' : 'active',
    );
    if (interaction.kind === 'orgPlanAttention' && interaction.turnId)
      interactions.retainAttentionReport(
        sessionId,
        interaction.turnId,
        journal.attentionReport(sessionId, interaction.turnId, interaction.requestedAt),
      );
    try {
      activity.observe({
        sessionId,
        occurredAt: interaction.requestedAt,
        kind: 'interactionPending',
        ...(interaction.kind === 'orgPlanAttention'
          ? { attentionReason: (interaction.payload as OrgPlanAttention).reason }
          : {}),
      });
      autopilot.semanticEvent(sessionId, 'interactionChanged');
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
          journal.append(sessionId, 'org-plan.attention-required', interaction, updated.updatedAt),
        );
      autopilot.evaluate(sessionId);
    } catch (error) {
      if (!acknowledgeAttention || interaction.kind !== 'orgPlanAttention') throw error;
      attentionDiagnostic('%o', {
        requestId: interaction.requestId,
        reasonCode: 'postPersistenceProjectionFailed',
      });
    }
    return true;
  };
  const acceptPlanUpdate = (sessionId: string, update: PlanStatusUpdate): void => {
    if (closing) return;
    supervisedPlans.accept(sessionId, update);
    planMeasurementRefresh?.accept(sessionId, update);
    if (update.kind === 'updated') {
      void runtime?.syncThreadPlanName(sessionId, update.plan);
      const occurredAt = new Date().toISOString();
      const session = sessions.find(sessionId);
      if (session) {
        const execution = autopilotStore.find(sessionId);
        const launchOwner = orgPlanLaunches.owner(update.planPath);
        const takeoverOwner = takeoverStore.owner(update.identity);
        const updated = {
          ...session,
          lastOrgPlan: {
            filename: basename(update.planPath),
            title: update.plan.title,
            path: update.planPath,
            attached: true,
            supervision:
              session.desiredState !== 'stopped' &&
              (takeoverOwner
                ? takeoverOwner.sessionId === sessionId
                : !launchOwner || launchOwner.sessionId === sessionId) &&
              planAttachmentSupervision(
                session.lastOrgPlan,
                update,
                execution?.planIdentity === update.identity && !!execution.supervision,
              ),
          },
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
    publishSessionStatus(sessionId, new Date().toISOString());
  };
  runtime = options.startAppServers
    ? new CodexSessionRuntime(
        options.launchAppServer ?? launchCodexAppServer,
        undefined,
        (sessionId, notification, origin) => {
          const occurredAt = new Date().toISOString();
          if (notification.method === 'gestalt/mcpStartup') {
            const status = parseMcpStartupStatus(notification.params);
            if (!status) return;
            events.publish(
              journal.append(sessionId, 'agent.activity.mcp-startup', status, status.observedAt),
            );
          }
          const activityFacts = decodeAgentActivityFacts(sessionId, occurredAt, notification);
          const resolvedRequestId = resolvedServerRequestId(notification);
          if (resolvedRequestId) {
            const interaction = interactions.find(sessionId, resolvedRequestId);
            const outcome = interaction?.kind === 'orgPlanAttention' ? 'failed' : 'dismissed';
            if (
              !(
                interaction?.kind === 'orgPlanAttention' &&
                interactions.resolutionState(sessionId, resolvedRequestId) === 'acknowledged'
              ) &&
              interaction?.kind !== 'quiz' &&
              interactions.resolve(sessionId, resolvedRequestId, occurredAt, outcome)
            ) {
              if (outcome === 'failed')
                publishAttentionSettlement(sessionId, resolvedRequestId, occurredAt, outcome);
              else publishInteractionResolved(sessionId, resolvedRequestId, occurredAt, outcome);
            }
          }
          const currentSession = sessions.find(sessionId);
          if (currentSession) {
            for (const fact of decodeToolEfficiencyFacts(sessionId, occurredAt, notification, {
              runtimeId: origin.runtimeId,
              rootThreadId: currentSession.threadId ?? undefined,
              physicalThreadId: origin.physicalThreadId,
              physicalTurnId: origin.physicalTurnId,
              actor: origin.kind,
            })) {
              const snapshot = toolEfficiency.observe(fact);
              if (snapshot)
                events.publish(
                  journal.append(sessionId, 'tool.efficiency.updated', snapshot, occurredAt),
                );
            }
          }
          const completionTurnId =
            notification.method === 'turn/completed' &&
            notification.params &&
            typeof notification.params === 'object' &&
            typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === 'string'
              ? (notification.params as { turn: { id: string } }).turn.id
              : undefined;
          // A completion with no thread identity is only root-owned when it exactly
          // matches the durable active root turn; unknown child turns never fall back.
          const resolvedOrigin =
            origin.kind === 'unknown' && completionTurnId === currentSession?.activeTurnId
              ? { ...origin, kind: 'root' as const }
              : origin;
          const normalized = normalizeCodexNotification(
            sessionId,
            0,
            occurredAt,
            notification,
            currentSession?.workspacePath,
            currentSession?.activeTurnId,
            resolvedOrigin,
          );
          // Pause before activity/completion can schedule another automatic turn.
          // Unknown threads must not stop an unrelated session on the shared server.
          // Codex may emit the terminal error separately and omit it from the
          // completion. Carry forward only evidence for this exact active root.
          const settledFailure =
            resolvedOrigin.kind === 'root' &&
            completionTurnId === currentSession?.activeTurnId &&
            (notification.params as { turn?: { status?: unknown } } | null)?.turn?.status ===
              'failed'
              ? autopilotStore.find(sessionId)
              : null;
          const providerFailure =
            decodeCodexFailure(notification) ??
            (settledFailure?.providerFailureTurnId === completionTurnId
              ? settledFailure?.providerFailure
              : undefined);
          if (resolvedOrigin.kind !== 'unknown' && providerFailure)
            autopilot.providerFailed(sessionId, providerFailure, {
              actor: resolvedOrigin.kind === 'root' ? 'root' : 'child',
              turnId:
                completionTurnId ??
                (typeof (notification.params as { turnId?: unknown })?.turnId === 'string'
                  ? (notification.params as { turnId: string }).turnId
                  : resolvedOrigin.physicalTurnId),
              settled: notification.method === 'turn/completed',
            });
          const rootCommandId =
            resolvedOrigin.kind === 'root' ? completedCommandId(notification) : null;
          if (rootCommandId) autopilot.rootProcessCompleted(sessionId, rootCommandId);
          const refreshChildTopology =
            notification.method === 'item/completed' &&
            activityFacts.some(
              (fact) =>
                fact.kind === 'collaboration' &&
                (fact.collaborationAction === 'spawn_agent' ||
                  fact.collaborationAction === 'resume_agent' ||
                  fact.collaborationAction === 'close_agent'),
            );
          if (!normalized) {
            for (const activityFact of activityFacts) activity.observe(activityFact);
            if (refreshChildTopology) void activity.refresh(sessionId);
            return;
          }
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
              if (!providerFailure) autopilot.turnCompleted(sessionId, turnId);
            }
            planMeasurementRefresh?.refreshNow(sessionId);
          }
          // Activity publication also derives and broadcasts the session verdict.
          // Complete the durable turn first so its status cannot retain the just-finished
          // activeTurnId while the completion fact makes the root appear idle.
          for (const activityFact of activityFacts) activity.observe(activityFact);
          // Re-evaluate once both halves of the safe continuation boundary are
          // observable. turnCompleted() releases the durable checkpoint before
          // these facts project the idle root; its first evaluation can therefore
          // still see the pre-completion activity snapshot. This second evaluation
          // is idempotently fenced by the durable control row.
          if (completedSession) {
            if (providerFailure && completionTurnId)
              providerRecovery.failed(completedSession, completionTurnId, providerFailure);
            else providerRecovery.cancel(sessionId);
            autopilot.evaluate(sessionId);
          }
          // Lifecycle notifications are fast transition evidence, while
          // thread/list is the bounded topology authority. Reconcile after the
          // mutation so canonical identity and every retained child reach both
          // the GUI and Autopilot even when the notification is sparse.
          if (refreshChildTopology) void activity.refresh(sessionId);
          if (normalized.type === 'agentMessageCompleted') {
            const message = normalized.payload as {
              turnId?: string;
              phase?: string;
              text?: string;
            };
            if (message.turnId && message.phase === 'final_answer')
              interactions.retainAttentionReport(sessionId, message.turnId, message.text);
          }
          events.publish(
            journal.append(sessionId, normalized.type, normalized.payload, normalized.occurredAt),
          );
          if (completedSession)
            events.publish(
              journal.append(sessionId, 'session.updated', completedSession, occurredAt),
            );
        },
        async (sessionId, request, origin) => {
          let rawInteraction = toPendingInteraction(request);
          const compactCheckpointKind = compactOrgPlanCheckpointKind(request);
          if (compactCheckpointKind || rawInteraction?.kind === 'orgPlanCheckpoint') {
            const refreshed = await checkpoints.refresh(sessionId, String(request.id));
            if (refreshed !== null) return refreshed;
          }
          const session = withPendingInteractions(sessions.find(sessionId));
          if (!session) return false;
          if (isManagedPlaywrightCall(request)) {
            const result = await playwright.control(
              playwrightAuthority(session),
              (request.params as { arguments?: unknown }).arguments,
              origin.kind === 'root' &&
                origin.physicalThreadId === session.threadId &&
                origin.physicalTurnId === session.activeTurnId,
            );
            return (
              runtime?.resolveServerRequest(sessionId, String(request.id), {
                success: true,
                contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
              }) === true
            );
          }
          const toolCall = request.params as { tool?: unknown; arguments?: unknown } | null;
          if (
            request.method === 'item/tool/call' &&
            toolCall?.tool === gestaltTestRunnerDynamicTool.name
          ) {
            const result = await handleHostTestTool(
              hostTests,
              {
                sessionId,
                workspace: session.workspacePath,
                root: origin?.kind === 'root',
                provider: session.provider,
                waitForRun: (runId, maxWaitMs) => {
                  const current = sessions.find(sessionId);
                  if (
                    origin?.kind !== 'root' ||
                    !current?.activeTurnId ||
                    origin.physicalTurnId !== current.activeTurnId
                  )
                    return false;
                  const state = autopilotStore.find(sessionId);
                  if (!state?.requestedEnabled) return false;
                  const leaseId = `host-test:${runId}:${current.activeTurnId}`;
                  if (state.supervision?.waitLease?.id === leaseId) return true;
                  return autopilot.registerProactiveWait(sessionId, {
                    id: leaseId,
                    leaseId,
                    runId,
                    maxWaitMs,
                    wakeConditions: ['processResultAvailable'],
                  });
                },
              },
              toolCall.arguments,
            );
            return (
              runtime?.resolveServerRequest(sessionId, String(request.id), {
                success: true,
                contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
              }) === true
            );
          }
          if (isOrgPlanHealthCall(request)) {
            const observedPlan = supervisedPlans.find(sessionId);
            let executorBinding =
              observedPlan?.modelPolicyVersion === 1
                ? autopilot.reconcileExecutorBinding(sessionId)
                : null;
            if (
              executorBinding &&
              [
                'ROSTER_UNAVAILABLE',
                'ROOT_BINDING_MISMATCH',
                'EXECUTOR_NOT_OBSERVED',
                'EXECUTOR_UNAVAILABLE',
                'EXECUTOR_IDENTITY_INVALID',
                'EXECUTOR_AMBIGUOUS',
                'REPLACEMENT_NOT_AUTHORIZED',
                'PREVIOUS_WRITER_ACTIVE',
                'AUTHORIZED_REPLACEMENT_PENDING',
              ].includes(executorBinding.code) &&
              runtime
            ) {
              const topologyRevision = activity.observationRevision(sessionId);
              const topology = await runtime.readExecutorTopology(session);
              if (
                topology.kind === 'observed' &&
                activity.observationRevision(sessionId) === topologyRevision &&
                sessions.find(sessionId)?.threadId === topology.rootThreadId
              ) {
                // Seed identity only. A topology read must not overwrite newer root turn activity.
                if (!activity.snapshot(sessionId, topology.observedAt).rootThreadId)
                  activity.observe({
                    sessionId,
                    kind: 'threadStarted',
                    threadId: topology.rootThreadId,
                    occurredAt: topology.observedAt,
                  });
                activity.childrenReconciled(sessionId, topology.observedAt, topology.children);
                executorBinding = autopilot.reconcileExecutorBinding(sessionId);
              } else {
                executorBinding = autopilot.reconcileExecutorBinding(sessionId);
                if (executorBinding.status !== 'ready')
                  executorBinding = {
                    ...executorBinding,
                    status: 'unavailable',
                    code: topology.kind === 'unavailable' ? topology.code : 'CONTEXT_CHANGED',
                    action:
                      'Current topology could not be verified. Keep the existing writer paused and retry a bounded health read after runtime evidence changes; do not replace it to repair a projection.',
                  };
              }
            }
            const [modelPolicy, executorLaunch] = await Promise.all([
              executorModelEvidence.read(sessionId),
              executorLaunchValidation.read(sessionId),
            ]);
            const snapshot = autopilot.snapshot(sessionId);
            const args = parseOrgPlanHealthArguments(toolCall?.arguments)!;
            const healthReport =
              args.view === 'compact'
                ? supervisionSnapshots.read(
                    sessionId,
                    compactSupervisionSnapshot({
                      autopilot: snapshot,
                      plan: supervisedPlans.find(sessionId),
                      planIdentity: supervisedPlans.identity(sessionId),
                      activity: activity.snapshot(sessionId, new Date().toISOString()),
                      pendingInteractions: blockingInteractions(sessionId).length,
                      tests: hostTests?.supervisionSummary(sessionId) ?? {
                        enabled: false,
                        running: 0,
                        unread: 0,
                        omitted: 0,
                        runs: [],
                      },
                      wait: autopilotStore.find(sessionId)?.supervision?.waitLease ?? null,
                      binding: executorBinding
                        ? { status: executorBinding.status, code: executorBinding.code }
                        : null,
                      modelPolicy,
                      launch: executorLaunch,
                    }),
                    args.sinceRevision,
                  )
                : {
                    state: snapshot.state,
                    enabled: snapshot.enabled,
                    health: snapshot.health,
                    reason: snapshot.reason,
                    ...(snapshot.executionAdmission
                      ? { executionAdmission: snapshot.executionAdmission }
                      : {}),
                    ...(modelPolicy ? { modelPolicy } : {}),
                    ...(executorLaunch ? { executorLaunch } : {}),
                    ...(executorBinding ? { executorBinding } : {}),
                  };
            return (
              runtime?.resolveServerRequest(sessionId, String(request.id), {
                success: true,
                contentItems: [
                  {
                    type: 'inputText',
                    text: JSON.stringify(healthReport),
                  },
                ],
              }) === true
            );
          }
          if (!rawInteraction && compactCheckpointKind) {
            const expanded = checkpoints.expand(
              sessionId,
              String(request.id),
              compactCheckpointKind,
            );
            if ('handled' in expanded) return expanded.handled;
            rawInteraction = expanded.interaction;
          }
          if (!rawInteraction && isOrgPlanTakeoverCall(request)) {
            const result =
              origin.kind === 'root' &&
              origin.physicalTurnId === session.activeTurnId &&
              session.threadId
                ? await takeover.takeOver(sessionId, session.threadId, session.activeTurnId!)
                : { accepted: false as const, code: 'CURRENT_ROOT_REQUIRED' };
            const response =
              result.accepted && 'identity' in result
                ? {
                    ...result,
                    instruction: result.boundaryFinalRequired
                      ? 'The previous root has a persisted checkpoint awaiting its mandatory report. Emit that boundary final now and end this root turn without launching an executor. The following root turn will receive the authorized executor identity through the normal checkpoint continuation.'
                      : 'Mobile already stopped and retired the previous supervisors. This takeover is authorized by the user instruction. Do not follow up or interrupt old-root agent IDs. Consult this root’s native roster: resume the returned task name if present, otherwise launch it exactly once. ' +
                        autopilotExecutorLaunchPrompt(
                          result.identity,
                          supervisedPlans.find(sessionId),
                        ),
                  }
                : result;
            return (
              runtime?.resolveServerRequest(sessionId, String(request.id), {
                success: true,
                contentItems: [{ type: 'inputText', text: JSON.stringify(response) }],
              }) === true
            );
          }
          if (!rawInteraction && isAgentCapacityRecoveryCall(request)) {
            const rootOwned =
              origin.kind === 'root' && origin.physicalTurnId === session.activeTurnId;
            return (
              rootOwned &&
              scheduleAgentCapacityRecovery(
                sessionId,
                () =>
                  runtime?.resolveServerRequest(
                    sessionId,
                    String(request.id),
                    agentCapacityRecoveryToolResponse(),
                  ) === true,
              )
            );
          }
          if (!rawInteraction && isAutopilotWaitLeaseCall(request)) {
            // Invalid tool arguments are recoverable in this turn. They do not
            // establish that supervision is stalled or revoke continuation.
            return (
              runtime?.resolveServerRequest(
                sessionId,
                String(request.id),
                autopilotWaitLeaseToolResponse(false, 'invalidWaitLease'),
              ) === true
            );
          }
          if (!rawInteraction) return false;
          if (rawInteraction.kind === 'autopilotWaitLease') {
            const lease = rawInteraction.payload as AutopilotWaitLease;
            const rootOwned =
              origin.kind === 'root' && origin.physicalTurnId === session.activeTurnId;
            const registration =
              rootOwned &&
              (lease.version === 2
                ? autopilot.registerProactiveWait(sessionId, {
                    id: lease.reportId,
                    leaseId: lease.leaseId,
                    wakeConditions: lease.wakeConditions,
                    maxWaitMs: lease.maxWaitMs,
                  })
                : autopilot.reportProbe(sessionId, {
                    id: lease.reportId,
                    kind: 'wait',
                    leaseId: lease.leaseId,
                    wakeConditions: lease.wakeConditions,
                  }));
            if (registration !== true) {
              return (
                runtime?.resolveServerRequest(
                  sessionId,
                  rawInteraction.requestId,
                  autopilotWaitLeaseToolResponse(
                    false,
                    registration === 'wakeAlreadySatisfied'
                      ? 'wakeAlreadySatisfied'
                      : 'automaticContinuationUnavailable',
                  ),
                ) === true
              );
            }
            return (
              runtime?.resolveServerRequest(
                sessionId,
                rawInteraction.requestId,
                autopilotWaitLeaseToolResponse(),
              ) === true
            );
          }
          if (rawInteraction.kind === 'orgPlanCheckpoint')
            return checkpoints.accept(sessionId, rawInteraction, {
              activeTurnId: session.activeTurnId,
              rootOwned: origin.kind === 'root' && origin.physicalTurnId === session.activeTurnId,
              compactKind: compactCheckpointKind,
            });
          if (rawInteraction.kind === 'orgPlanAttention') {
            try {
              acceptPendingInteraction(sessionId, rawInteraction, session, true);
              const acknowledged =
                runtime?.resolveServerRequest(
                  sessionId,
                  rawInteraction.requestId,
                  toOrgPlanAttentionAcknowledgement(),
                ) === true;
              if (acknowledged) attentionAcknowledgement.arm(sessionId, rawInteraction.requestId);
              return acknowledged;
            } catch {
              const rejected =
                runtime?.resolveServerRequest(
                  sessionId,
                  rawInteraction.requestId,
                  toOrgPlanAttentionAcknowledgement({
                    accepted: false,
                    reason: 'persistenceFailed',
                  }),
                ) === true;
              if (rejected) attentionAcknowledgement.arm(sessionId, rawInteraction.requestId);
              return rejected;
            }
          }
          return acceptPendingInteraction(sessionId, rawInteraction, session);
        },
        (sessionId) => {
          activity.disconnected(sessionId, new Date().toISOString());
          checkpoints.failPending(sessionId, false);
          dismissPendingInteractions(sessionId, new Date().toISOString(), 'failed');
          recoverExitedSession(sessionId);
        },
        undefined,
        planStatusSource,
        acceptPlanUpdate,
        options.planMeasurementBaseUrl,
        30_000,
        64,
        root,
        (session) => sessionModelConfig.resolve(session),
        {
          prepare: async (session, rpc, config, deadline) => {
            const catalog = await new CodexSkillCatalog(
              session.profile,
              options.launchAppServer ?? launchCodexAppServer,
              Math.max(1, deadline - Date.now()),
            ).list(session.workspacePath);
            const project = await skillProfiles.readWorkspaceDefault(session.workspacePath);
            const selected = compileSkillOverride({
              discovered: catalog.skills,
              explicit:
                session.effectiveSkillSelection?.skills ?? options.explicitSkillProfile?.skills,
              project: project?.skills,
            });
            const state = await capabilities.prepare({
              cwd: session.workspacePath,
              approvalPolicy: session.executionPolicy?.approvalPolicy ?? 'on-request',
              rpc,
              config,
              deadline,
              skills: catalog.skills,
              skillsConfig: selected.skillsConfig,
              start: true,
              startup: !session.threadId,
            });
            return playwright.prepare(state, playwrightAuthority(session), {
              rpc,
              skills: catalog.skills,
              deadline: Date.now() + 5_000,
              current: () => playwrightAuthority(sessions.find(session.id) ?? session),
            });
          },
          verify: async (rpc, threadId, state) => {
            const base = playwright.base(state);
            const [retrievalReady, browserReady] = await Promise.all([
              capabilities.verify(rpc, threadId, base),
              playwright.verify(rpc, threadId, state),
            ]);
            return retrievalReady && browserReady;
          },
          needsResume: (session) => playwright.needsResume(playwrightAuthority(session)),
          release: (sessionId) => playwright.release(sessionId),
          observe: (sessionId, notification) => playwright.observe(sessionId, notification),
          bound: (state, threadId) => playwright.bound(state, threadId),
        },
        async (sessionId, threadId) => {
          requireOrgExecutionAdmission(sessionId);
          const plan = supervisedPlans.find(sessionId);
          if (plan?.modelPolicyVersion !== 1) return;
          const planFence = JSON.stringify(plan);
          const fence = () => {
            const state = autopilotStore.find(sessionId);
            return state?.requestedEnabled && state.executor?.threadId === threadId
              ? JSON.stringify([state.generation, state.planIdentity, state.executor])
              : null;
          };
          const before = fence();
          const assertCurrent = () => {
            requireOrgExecutionAdmission(sessionId);
            if (
              !before ||
              fence() !== before ||
              JSON.stringify(supervisedPlans.find(sessionId)) !== planFence ||
              blockingInteractions(sessionId).length
            )
              throw new Error('EXECUTOR_AUTHORITY_CHANGED');
          };
          assertCurrent();
          const report = await executorModelEvidence.read(sessionId);
          assertCurrent();
          const settingsChange =
            report && ['MODEL_MISMATCH', 'EFFORT_MISMATCH'].includes(report.code);
          if (
            !report ||
            report.child.threadId !== threadId ||
            (report.configuration === 'mismatch' && !settingsChange) ||
            [
              'CONTROLLER_BINDING_INVALID',
              'CONTEXT_CHANGED',
              'CHILD_BINDING_MISMATCH',
              'OBSERVATION_CHANGED',
            ].includes(report.code)
          )
            throw new Error(`EXECUTOR_POLICY_BLOCKED:${report?.code ?? 'CHILD_BINDING_UNKNOWN'}`);
          // The supervisor's current L1 choice is applied at this safe turn
          // boundary, including a deliberate change from the child's old model.
          await runtime!.validateExecutorPolicy(sessionId, report.requested);
          assertCurrent();
          return { ...report.requested, assertCurrent };
        },
        sessionScratch,
        new SqliteRuntimeReleaseStore(database),
      )
    : null;
  const handleKimiNotification = (
    sessionId: string,
    event: import('./platform/kimi/kimi-ws-client.js').KimiWsEvent,
  ): void => {
    const occurredAt = new Date().toISOString();
    const session = sessions.find(sessionId);
    const context = kimiRuntime?.eventContext(sessionId) ?? {
      resolveTurnId: () => null,
      isChildAgent: () => false,
    };
    for (const fact of decodeKimiActivityFacts(sessionId, occurredAt, event, context))
      activity.observe(fact);
    const normalized = normalizeKimiEvent(sessionId, 0, occurredAt, event, {
      ...context,
      workspacePath: session?.workspacePath,
      activeTurnId: session?.activeTurnId,
    });
    if (!normalized) return;
    let completedSession: RelaySessionSnapshot | undefined;
    if (normalized.type === 'turnCompleted' || normalized.type === 'turnInterrupted') {
      const turnId = (normalized.payload as { turn?: { id?: string } }).turn?.id;
      if (session && turnId && session.activeTurnId === turnId) {
        completedSession = RelaySession.rehydrate(session).completeTurn(
          turnId,
          occurredAt,
        ).snapshot;
        sessions.save(completedSession);
      }
    }
    events.publish(journal.append(sessionId, normalized.type, normalized.payload, occurredAt));
    if (completedSession)
      events.publish(journal.append(sessionId, 'session.updated', completedSession, occurredAt));
  };
  const handleKimiServerRequest = (
    sessionId: string,
    request: { id: number; method: string; params: unknown },
  ): boolean => {
    const rawInteraction = toPendingInteraction(request);
    const session = withPendingInteractions(sessions.find(sessionId));
    if (!rawInteraction || !session) return false;
    if (rawInteraction.kind !== 'orgPlanAttention')
      return acceptPendingInteraction(sessionId, rawInteraction, session);
    try {
      acceptPendingInteraction(sessionId, rawInteraction, session, true);
      void kimiRuntime?.resolveServerRequest(
        sessionId,
        rawInteraction.requestId,
        toOrgPlanAttentionAcknowledgement(),
      );
    } catch {
      void kimiRuntime?.resolveServerRequest(
        sessionId,
        rawInteraction.requestId,
        toOrgPlanAttentionAcknowledgement({ accepted: false, reason: 'persistenceFailed' }),
      );
    }
    return true;
  };
  kimiRuntime = kimiManager
    ? new KimiSessionRuntime({
        servers: kimiManager,
        scratch: sessionScratch,
        skillsFor: async (session) => {
          const config = await resolveSkills(session);
          return config?.map((entry) => ({
            name: basename(entry.path),
            path: entry.path,
            enabled: entry.enabled,
          }));
        },
        onNotification: (sessionId, event) => handleKimiNotification(sessionId, event),
        onServerRequest: (sessionId, request) => handleKimiServerRequest(sessionId, request),
        onExit: (sessionId) => {
          activity.disconnected(sessionId, new Date().toISOString());
          dismissPendingInteractions(sessionId, new Date().toISOString(), 'failed');
          recoverExitedKimiSession(sessionId);
        },
      })
    : null;
  runtime?.onServerResponseSettled((sessionId, requestId, outcome) => {
    if (attentionAcknowledgement.responseSettled(sessionId, requestId)) return;
    checkpoints.responseSettled(sessionId, requestId, outcome);
  });
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
  const notifySessionSaved = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
    prior: RelaySessionSnapshot | null,
  ) => {
    reconcileOrgPlanReceipt(session.id);
    events.publish(journal.append(session.id, 'session.updated', session, session.updatedAt));
    const becameRuntimeReady =
      prior &&
      prior.state !== 'ready' &&
      prior.state !== 'turnActive' &&
      (session.state === 'ready' || session.state === 'turnActive');
    if (
      (runtime || kimiRuntime) &&
      session.threadId &&
      (!prior || prior.threadId !== session.threadId || becameRuntimeReady)
    )
      void activity.refresh(session.id);
    if (becameRuntimeReady) autopilot.restore(session.id);
  };
  const saveSession = (session: RelaySessionSnapshot) => {
    if (forgetOperations.find(session.id)) return;
    const prior = sessions.find(session.id);
    sessions.save(session);
    notifySessionSaved(session, prior);
  };
  const notifyCommittedSession = (id: string, prior: RelaySessionSnapshot | null) => {
    if (forgetOperations.find(id)) return null;
    const current = sessions.find(id);
    if (current) notifySessionSaved(current, prior);
    return current;
  };
  const publishSession = (
    session: import('./features/sessions/model/relay-session.js').RelaySessionSnapshot,
    beforeCommit?: () => void,
    commit?: () => void,
  ) =>
    withScratchContainment(session.workspacePath, () => {
      assertWorkspaceOwner(session);
      beforeCommit?.();
      if (commit) commit();
      else saveSession(session);
    });
  if (kimiRuntime) {
    // A gestalt-owned kimi web process exited or its websocket dropped: stop
    // the durable session like the codex supervisor does, without a resume
    // retry (a later activation reattaches through the normal writer path).
    recoverExitedKimiSession = (sessionId) => {
      const session = sessions.find(sessionId);
      if (session) {
        autopilot.cancel(sessionId, 'sessionEnded');
        saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
      }
    };
  }
  /** Routes a session to the runtime owning its provider's llm service. */
  const ownerRuntime = (session: Readonly<{ provider: LlmProvider }>) =>
    session.provider === 'kimi' ? kimiRuntime : runtime;
  const scratchCleanup = new FilesystemScratchCleanup();
  const workspaceForget = new FilesystemWorkspaceForget(database);
  const cleanTmp = new CleanSessionScratch({
    sessions: () => sessions.list(),
    knownWorkspacePaths: async () => [root, ...sessions.knownWorkspacePaths()],
    additionalWorkspacePaths: () => workspaces.knownWorkspacePaths(),
    storage: scratchCleanup,
  });
  const forgetSessions = new ForgetSession({
    operations: forgetOperations,
    find: (id) => sessions.find(id),
    now: () => new Date().toISOString(),
    release: async (session) => {
      providerRecovery.cancel(session.id);
      autopilot.cancel(session.id, 'sessionEnded');
      planMeasurementRefresh?.stop(session.id);
      dismissPendingInteractions(session.id, new Date().toISOString());
      activity.dispose(session.id);
      await hostTests?.cancelSession(session.id);
      await capacityRecoveryTasks.get(session.id)?.catch(() => undefined);
      await ownerRuntime(session)?.releaseForForget(session);
      await playwright.waitForRelease(session.id);
    },
    clean: (session, operationId) =>
      workspaceForget.clean(
        session,
        operationId,
        () => {
          const operation = forgetOperations.find(session.id);
          return operation?.operationId === operationId && operation.phase === 'cleaning';
        },
        () => sessions.list(),
      ),
    changed: (operation) => {
      if (sessions.find(operation.sessionId))
        events.publish(
          journal.append(
            operation.sessionId,
            'session.forget.updated',
            operation,
            operation.updatedAt,
          ),
        );
    },
  });
  if (runtime) {
    scheduleAgentCapacityRecovery = (sessionId, acknowledge) => {
      if (closing || capacityRecoveries.has(sessionId) || !acknowledge()) return false;
      capacityRecoveries.add(sessionId);
      const timer = setTimeout(() => {
        capacityRecoveryTimers.delete(sessionId);
        const task = Promise.resolve().then(async () => {
          try {
            if (closing) return;
            const session = sessions.find(sessionId);
            if (!session || session.desiredState !== 'active' || !session.threadId) return;
            const recovering = RelaySession.rehydrate(session).beginRecovery(
              new Date().toISOString(),
            ).snapshot;
            saveSession(recovering);
            try {
              const restored = await runtime.recycle(recovering, new Date().toISOString());
              saveSession(restored);
            } catch {
              const current = sessions.find(sessionId);
              if (current)
                saveSession(
                  RelaySession.rehydrate(current).requireAttention(new Date().toISOString())
                    .snapshot,
                );
            }
          } finally {
            capacityRecoveries.delete(sessionId);
            capacityRecoveryTasks.delete(sessionId);
          }
        });
        capacityRecoveryTasks.set(sessionId, task);
      }, 500);
      capacityRecoveryTimers.set(sessionId, timer);
      return true;
    };
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
      providerRecovery.cancel(sessionId);
      supervisor.cancel(sessionId);
      const session = sessions.find(sessionId);
      if (session) {
        autopilot.cancel(sessionId, 'sessionEnded');
        saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
      }
    };
  }
  const attentionResolution = new AttentionResolution({
    operations: {
      find: (id, requestId) => interactions.find(id, requestId),
      terminalOperation: (id, requestId) => interactions.terminalOperation(id, requestId),
      claimOperation: (id, requestId, key) => interactions.claimOperation(id, requestId, key),
      resolved: (id, requestId) => interactions.resolved(id, requestId),
      resolutionState: (id, requestId) => interactions.resolutionState(id, requestId),
      beginDelivery: (id, requestId, key) => interactions.beginDelivery(id, requestId, key),
      retryDelivery: (id, requestId, key, state) =>
        interactions.retryDelivery(id, requestId, key, state),
      settleOperation: (id, requestId, key, at, outcome) =>
        interactions.settleOperation(id, requestId, key, at, outcome),
    },
    replay: {
      find: (scope, key) => idempotency.get(scope, key),
      remember: (scope, key, body) => idempotency.put(scope, key, 202, body),
    },
    writer: {
      available: () => runtime !== null,
      capable: (id) => sessions.find(id)?.attentionToolCapability === 'supported',
      state: (id, requestId) => runtime!.attentionWriterState(id, requestId),
      resolve: (id, requestId, response) => runtime!.resolveServerRequest(id, requestId, response),
      guidance: (sessionId) => {
        const session = sessions.find(sessionId);
        if (!runtime || !session) return null;
        return async (text, operationKey) =>
          withWorkspaceAdmission(sessionId, async () => {
            const writer = await runtime!.ensureWriter(session, new Date().toISOString());
            if (writer.session.activeTurnId)
              await runtime!.queueTurnInput(
                writer.session,
                writer.session.activeTurnId,
                text,
                operationKey,
              );
            else {
              const started = await runtime!.startTurn(
                writer.session,
                text,
                operationKey,
                new Date().toISOString(),
              );
              sessions.save(started);
              activity.observe({
                sessionId,
                occurredAt: started.updatedAt,
                kind: 'turnStarted',
                threadId: started.threadId!,
                turnId: started.activeTurnId!,
              });
            }
          });
      },
    },
    policy: {
      authorizeReplacement: (id, taskName) =>
        autopilot.authorizeExecutorReplacement(id, taskName).accepted,
      enable: (id) => autopilot.enable(id),
      disable: (id) => autopilot.disable(id),
    },
    publishSettlement: publishAttentionSettlement,
    now: () => new Date().toISOString(),
  });
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
  const orgPlanStarting = new Map<string, number>();
  const ordinarySessionLifecycle: Parameters<typeof startSession>[1] = {
    createId: randomUUID,
    now: () => new Date().toISOString(),
    save: saveSession,
    publish: publishSession,
    workspaces,
    profiles: options.profiles,
    models,
    sessionModels,
    skillProfiles,
    skillCatalog,
    defaultSkillProfile: options.explicitSkillProfile,
    activate:
      runtime || kimiRuntime
        ? async (session) => {
            assertWorkspaceOwner(session);
            const now = new Date().toISOString();
            dismissPendingInteractions(session.id, now);
            const owner = ownerRuntime(session);
            if (!owner) throw new Error('LLM_RUNTIME_UNAVAILABLE');
            return withWorkspaceAdmission(session.id, () => owner.start(session, now));
          }
        : undefined,
  };
  const ordinaryTurnDependencies: StartTurnDependencies = {
    find: (id) => withPendingInteractions(sessions.find(id)),
    save: saveSession,
    idempotency,
    onSettled: (id) => autopilot.activityChanged(id),
    onAccepted: (session, key) => {
      const record = orgPlanLaunches.forSession(session.id);
      if (
        record &&
        ['session', 'submitting'].includes(record.phase) &&
        key !== `org-plan-bootstrap:${record.launchId}` &&
        session.activeTurnId
      )
        orgPlanLaunches.save(
          { ...record, phase: 'submitting', manualRecoveryTurnId: session.activeTurnId },
          record.phase,
        );
    },
    start: async (session, text, clientUserMessageId) =>
      withWorkspaceAdmission(session.id, async () => {
        providerRecovery.cancel(session.id);
        autopilot.manualSend(session.id);
        const owner = ownerRuntime(session);
        if (!owner) throw new Error('LLM_RUNTIME_UNAVAILABLE');
        if (session.provider === 'codex' && runtime)
          return runtime.startTurn(
            session,
            text,
            clientUserMessageId,
            new Date().toISOString(),
            () => {
              const current = sessions.find(session.id);
              return Boolean(
                current?.desiredState === 'active' &&
                current.threadId === session.threadId &&
                !forgetOperations.find(session.id),
              );
            },
          );
        return owner.startTurn(session, text, clientUserMessageId, new Date().toISOString());
      }),
    ensureWriter:
      runtime || kimiRuntime
        ? async (session) =>
            withWorkspaceAdmission(session.id, async () => {
              if (supervisorOwnership(session.id) === 'replaced')
                throw new WriterAcquisitionError('supervisorReplaced');
              dismissPendingInteractions(session.id, new Date().toISOString());
              const owner = ownerRuntime(session);
              if (!owner) throw new Error('LLM_RUNTIME_UNAVAILABLE');
              if (!session.threadId && orgPlanLaunches.forSession(session.id))
                return {
                  session: await activateInitialPlanSession(session),
                  replacementCreated: false,
                  persisted: true,
                };
              return owner.ensureWriter(
                await recoverExecutionPolicy(session),
                new Date().toISOString(),
              );
            })
        : undefined,
    releaseWriter:
      runtime || kimiRuntime
        ? async (id) => {
            providerRecovery.cancel(id);
            dismissPendingInteractions(id, new Date().toISOString());
            const session = sessions.find(id);
            const owner = session ? ownerRuntime(session) : null;
            if (owner && session) await owner.releaseForForget(session);
          }
        : undefined,
    onStarted: (session) => {
      activity.observe({
        sessionId: session.id,
        occurredAt: session.updatedAt,
        kind: 'turnStarted',
        ...(session.threadId ? { threadId: session.threadId } : {}),
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      });
      planMeasurementRefresh?.refreshNow(session.id);
    },
  };
  const initialActivationSessions = {
    find: (id: string) => (forgetOperations.find(id) ? null : sessions.find(id)),
    save: (session: RelaySessionSnapshot) => sessions.save(session),
  };
  const activateInitialPlanSession = async (session: RelaySessionSnapshot) => {
    if (!runtime || session.provider !== 'codex') throw new Error('LLM_RUNTIME_UNAVAILABLE');
    const attempt = orgPlanLaunches.claimInitialActivation(session.id, initialActivationSessions);
    if (!attempt) throw new Error('ORG_PLAN_INITIAL_ACTIVATION_UNSETTLED');
    const assertCurrent = () => {
      if (!orgPlanLaunches.initialActivationCurrent(attempt, initialActivationSessions))
        throw new Error('ORG_PLAN_INITIAL_ACTIVATION_FENCED');
    };
    try {
      dismissPendingInteractions(session.id, new Date().toISOString());
      const active = await runtime.start(session, new Date().toISOString(), {
        assertCurrent,
        beforeThreadStart: () => {
          if (!orgPlanLaunches.requestInitialThread(attempt, initialActivationSessions))
            throw new Error('ORG_PLAN_INITIAL_ACTIVATION_FENCED');
        },
      });
      if (!orgPlanLaunches.completeInitialActivation(attempt, active, initialActivationSessions)) {
        await runtime.release(session.id);
        throw new Error('ORG_PLAN_INITIAL_ACTIVATION_FENCED');
      }
      const current = notifyCommittedSession(session.id, session);
      if (!current || current.desiredState !== 'active') {
        await runtime.release(session.id);
        throw new Error('ORG_PLAN_INITIAL_ACTIVATION_FENCED');
      }
      return current;
    } catch (error) {
      orgPlanLaunches.failInitialActivation(attempt);
      throw error;
    }
  };
  const submitSessionTurn = createStartTurn(ordinaryTurnDependencies);
  ordinaryTurnPending = (id) => submitSessionTurn.pending?.(id) ?? false;
  const reclaimableLaunchOwner = (
    record: import('./features/plans/application/org-plan-launch-store.js').OrgPlanLaunchRecord,
  ) =>
    forgetOperations.find(record.sessionId)?.phase === 'completed' &&
    !sessions.find(record.sessionId) &&
    !runtime?.ownsWriter(record.sessionId);
  const workspaceBusy = (workspacePath: string) => {
    const session = sessions.list().find((session) => {
      if (
        !within(workspacePath, session.workspacePath) &&
        !within(session.workspacePath, workspacePath)
      )
        return false;
      const snapshot = activity.snapshot(session.id, new Date().toISOString());
      return Boolean(
        session.activeTurnId ||
        pendingRootTurn(session.id) ||
        workspaceAdmissions.has(session.id) ||
        orgPlanStarting.has(session.id) ||
        snapshot.subagents.some(
          (agent) =>
            ['working', 'awaitingAgent'].includes(agent.state) ||
            agent.ownedProcesses?.some((process) =>
              ['running', 'detached-active'].includes(process.state),
            ),
        ),
      );
    });
    return session
      ? {
          sessionId: session.id,
          reason:
            'Another session is working in this workspace. Stop its work before starting a supervisor.',
        }
      : null;
  };
  const prepareOrgPlan = (
    reference: import('../shared/contracts/org-plan-execution.js').OrgPlanReference,
    expectedRevision?: string,
    skillProfile?: string,
    ownUnpublishedLaunchId?: string,
  ) =>
    prepareOrgPlanSupervision(
      reference,
      {
        resolveReference: (ref) => orgPlanContext.resolveReference(ref),
        workspace: (path, revision) => orgPlanContext.workspace(path, revision),
        read: (workspacePath, planName) =>
          workspacePlanCatalog.readExecution(workspacePath, planName),
        runtimeAvailable: async () =>
          protocol.compatible
            ? { available: true }
            : {
                available: false,
                code: protocol.code!,
                reason:
                  'Codex CLI was not found when Mobile started. Install Codex and restart Mobile.',
              },
        policy: assessModelPolicyAdmission,
        settings: (workspacePath, selectedProfile) =>
          prepareOrgPlanSettings(
            workspacePath,
            {
              defaults: sessionDefaults,
              models: sessionModels,
              profiles: options.profiles,
              skillProfiles,
              skillCatalog,
              defaultSkillProfile: options.explicitSkillProfile,
            },
            selectedProfile,
          ),
        owner: async (canonicalPath, workspacePath) => {
          const pending =
            orgPlanLaunches.owner(canonicalPath) ?? orgPlanLaunches.workspaceOwner(workspacePath);
          const ownUnpublished =
            pending &&
            ownUnpublishedLaunchId &&
            pending.launchId === ownUnpublishedLaunchId &&
            !sessions.find(pending.sessionId) &&
            !runtime?.ownsWriter(pending.sessionId) &&
            ['reserved', 'creating'].includes(pending.phase);
          if (pending && !reclaimableLaunchOwner(pending) && !ownUnpublished)
            return {
              ...(sessions.find(pending.sessionId) ? { sessionId: pending.sessionId } : {}),
              reason:
                'This plan or an overlapping workspace is reserved by another supervisor. Open its session to continue, or close it to release the reservation.',
            };
          const busy = workspaceBusy(workspacePath);
          if (busy && busy.sessionId !== pending?.sessionId) return busy;
          const identity = createHash('sha256').update(canonicalPath).digest('hex');
          const owner = sessions.list().find((session) => {
            if (
              session.desiredState === 'stopped' &&
              ['stopped', 'released'].includes(session.state)
            )
              return false;
            if (!session.lastOrgPlan?.attached || session.lastOrgPlan.path !== canonicalPath)
              return false;
            const execution = autopilotStore.find(session.id);
            return (
              session.lastOrgPlan.supervision !== false ||
              (execution?.planIdentity === identity && !!execution.supervision)
            );
          });
          return owner ? { sessionId: owner.id } : null;
        },
      },
      expectedRevision,
      skillProfile,
    );
  // Both transports and future internal consumers retain the same scoped admission boundary.
  const startPlanSupervision = (
    request: import('../shared/contracts/org-plan-execution.js').OrgPlanLaunchRequest,
  ) =>
    startOrgPlanSupervision(request, {
      prepare: prepareOrgPlan,
      createId: randomUUID,
      launches: orgPlanLaunches,
      workspaceBusy,
      reclaimForgottenOwner: (path, workspacePath) => {
        const record = orgPlanLaunches.owner(path);
        if (record && reclaimableLaunchOwner(record)) orgPlanLaunches.releaseOwner(record);
        const workspaceOwner = orgPlanLaunches.workspaceOwner(workspacePath);
        if (workspaceOwner && reclaimableLaunchOwner(workspaceOwner))
          orgPlanLaunches.releaseOwner(workspaceOwner);
      },
      authorizeReplay: async (record) => {
        try {
          const workspace = await workspaces.resolve(record.context.workspace.id);
          return workspace.realPath === record.context.workspace.path;
        } catch {
          return false;
        }
      },
      captureSkills: (context) =>
        resolveSessionSkillSelection(
          {
            workspacePath: context.workspace.path,
            provider: 'codex',
            profile: 'default',
            ...(context.settings.skillProfile
              ? { skillProfile: context.settings.skillProfile }
              : {}),
          },
          { skillProfiles, skillCatalog, defaultSkillProfile: options.explicitSkillProfile },
        ),
      sessions: {
        create: async (id, context, selection, publication) => {
          orgPlanStarting.set(id, (orgPlanStarting.get(id) ?? 0) + 1);
          let publicationEntered = false;
          let ownsPublication = false;
          let publishedSession:
            import('./features/sessions/model/relay-session.js').RelaySessionSnapshot | null = null;
          try {
            return await startSession(
              { ...context.settings, workspaceId: context.workspace.id },
              {
                ...ordinarySessionLifecycle,
                createId: () => id,
                inheritedSkillSelection: selection,
                // Both lifecycle stages already commit through the guarded launch store.
                save: () => {},
                publish: (session) =>
                  publishSession(
                    session,
                    () => {
                      publicationEntered = true;
                    },
                    () => {
                      const receipt = orgPlanLaunches.publishSession(
                        publication,
                        session,
                        sessions,
                      );
                      ownsPublication = receipt.created;
                      publishedSession = receipt.session;
                      if (receipt.created) notifyCommittedSession(id, null);
                    },
                  ),
                activate: async (session) => {
                  if (!ownsPublication) return sessions.find(id) ?? publishedSession ?? session;
                  const active = await activateInitialPlanSession(session);
                  const current = sessions.find(id);
                  if (!current || current.desiredState === 'stopped') {
                    await ownerRuntime(active)?.release(id);
                    if (!current) throw new Error('SESSION_UNAVAILABLE');
                    return current;
                  }
                  return active;
                },
              },
            );
          } catch (error) {
            if (!publicationEntered) throw new OrgPlanSessionNotPublished();
            throw error;
          } finally {
            const count = (orgPlanStarting.get(id) ?? 1) - 1;
            if (count) orgPlanStarting.set(id, count);
            else orgPlanStarting.delete(id);
          }
        },
        recover: async (session) => {
          if (orgPlanStarting.has(session.id)) return null;
          if (!session.threadId) return activateInitialPlanSession(session);
          const acquisition = await ordinaryTurnDependencies.ensureWriter?.(session);
          if (!acquisition) return null;
          const current = sessions.find(session.id);
          if (!current || current.desiredState !== 'active') {
            await ownerRuntime(acquisition.session)?.release(session.id);
            return current;
          }
          saveSession(acquisition.session);
          return acquisition.session;
        },
        find: (id) => sessions.find(id),
        unavailable: (id) => Boolean(forgetOperations.find(id)),
      },
      submitTurn: submitSessionTurn,
      acceptedTurn: (record) =>
        record.bootstrapFingerprint
          ? readAcceptedTurn(
              idempotency,
              record.sessionId,
              `org-plan-bootstrap:${record.launchId}`,
              record.bootstrapFingerprint,
            )
          : null,
      onSettled: ordinaryTurnDependencies.onSettled,
    });
  let app;
  try {
    if (options.testRunnerEnabled !== false) {
      hostTests = new LocalHostTestRunner(
        join(dirname(databasePath), 'host-test-runs'),
        (sessionId, runId, observedAt) => {
          if (!sessions.find(sessionId)) return;
          events.publish(
            journal.append(sessionId, 'host-test.completed', { runId, observedAt }, observedAt),
          );
          autopilot.rootProcessCompleted(sessionId, runId);
        },
        async (workspace) => {
          if (!within(await realpath(root), await realpath(workspace)))
            throw new Error('Host test workspace is outside the configured root');
          return loadWorkspaceHostTestConfig(workspace);
        },
        sessionScratch,
      );
      await hostTests.initialize();
    }
    const transportDiagnostics = new SqliteTransportDiagnostics(database);
    app = await buildApp({
      transportDiagnostic: (id, event) => transportDiagnostics.record(id, event),
      upgrade: new ManagedUpgrade(options.root),
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
              protocolVersion: null,
              compatible: protocol.compatible,
            },
            providers: providerAvailability,
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
      pwaIcon: options.pwaIcon,
      recentThreads: recentThreadsForRelay,
      sessionDefaults,
      codexAllowance:
        options.installedCodexVersion === null
          ? {
              read: async () => ({
                weeklyRemainingPercent: null,
                weeklyResetsAt: null,
                resetsAvailable: null,
              }),
            }
          : new CodexAllowanceReader(root, options.launchAppServer ?? launchCodexAppServer),
      bootstrap: {
        sessionDefaults,
        workspaces,
        profiles: options.profiles,
        models,
        sessions: {
          list: () =>
            sessions.list().map((session) => {
              const plan = supervisedPlans.find(session.id);
              const forgetOperation = forgetOperations.find(session.id);
              return {
                ...withPendingInteractions(session)!,
                ...(plan ? { plan } : {}),
                ...(forgetOperation ? { forgetOperation } : {}),
              };
            }),
        },
        versions: options.componentVersions,
        headerIconUrl: options.pwaIcon ? pwaIconUrl(options.pwaIcon) : undefined,
        protocolCompatible: protocol.compatible,
        providers: providerAvailability,
      },
      selfDebug: runtime
        ? {
            find: (id) => sessions.find(id),
            createId: randomUUID,
            now: () => new Date().toISOString(),
            context: (source) => {
              const control = autopilotStore.find(source.id);
              return {
                handoffTrace: control?.checkpoints?.activeHandoffId ?? null,
                control: control?.lastControlId ?? null,
                mobileSession: source.id,
                codexThread: source.provider === 'codex' ? source.threadId! : null,
                sourceThread: source.threadId!,
                provider: source.provider,
                capturedAt: new Date().toISOString(),
                versions: options.componentVersions ?? [],
              };
            },
            readTrace: (debug) => debugWorkspace.readTrace(debug),
            problem: (sessionId, requestId) => {
              const interaction = pendingInteractionsWithReports(sessionId).find(
                (item) => item.kind === 'orgPlanAttention' && item.requestId === requestId,
              );
              const attention = interaction ? parseOrgPlanAttention(interaction.payload) : null;
              return interaction && attention
                ? {
                    requestId: interaction.requestId,
                    turnId: interaction.turnId ?? null,
                    requestedAt: interaction.requestedAt ?? null,
                    attention,
                    ...(interaction.supervisorReport
                      ? { supervisorReport: interaction.supervisorReport }
                      : {}),
                  }
                : null;
            },
            create: (context, problem) =>
              createSelfDebugSession(
                context,
                {
                  createId: randomUUID,
                  now: () => new Date().toISOString(),
                  settings: (source) =>
                    debugExecutionSettings(source, () => debugWorkspace.settings()),
                  capture: async (id, capturedContext, agent) => {
                    const captured = await debugWorkspace.capture(id, capturedContext, agent);
                    return {
                      ...captured,
                      absoluteTracePath: join(captured.root, captured.debug.tracePath),
                    };
                  },
                  createSession: async (id, root, agent, source) => {
                    await debugWorkspace.prepare();
                    const debugCatalog = new FilesystemWorkspaceCatalog(root);
                    const [workspace] = await debugCatalog.list();
                    return startSession(
                      {
                        workspaceId: workspace!.id,
                        profile: source.profile,
                        provider: 'codex',
                        model: agent.model,
                        reasoningEffort: agent.reasoningEffort,
                        sandbox: 'workspace-git',
                        approvalPolicy: 'never',
                      },
                      {
                        createId: () => id,
                        now: () => new Date().toISOString(),
                        save: saveSession,
                        publish: publishSession,
                        workspaces: debugCatalog,
                        profiles: options.profiles,
                        skillProfiles,
                        skillCatalog,
                        inheritedSkillSelection: source.effectiveSkillSelection,
                        sessionModels,
                      },
                    );
                  },
                  start: (session) => runtime.start(session, new Date().toISOString()),
                  startTurn: (session, prompt, messageId) =>
                    runtime.startTurn(session, prompt, messageId, new Date().toISOString()),
                  find: (id) => sessions.find(id),
                  save: saveSession,
                  onStarted: (session) =>
                    activity.observe({
                      sessionId: session.id,
                      occurredAt: session.updatedAt,
                      kind: 'turnStarted',
                      threadId: session.threadId!,
                      turnId: session.activeTurnId!,
                    }),
                },
                problem,
              ),
          }
        : undefined,
      sessionRoutes: {
        ...ordinarySessionLifecycle,
        forget: (id) => forgetSessions.execute(id),
        forgetOperation: (id) => forgetOperations.find(id),
        createId: randomUUID,
        now: () => new Date().toISOString(),
        save: saveSession,
        publish: publishSession,
        find: (id) => withPendingInteractions(sessions.find(id)),
        list: () => sessions.list().map((session) => withPendingInteractions(session)!),
        plan: (id) => supervisedPlans.find(id),
        workspaces,
        profiles: options.profiles,
        skillProfiles,
        skillCatalog,
        defaultSkillProfile: options.explicitSkillProfile,
        activate: ordinarySessionLifecycle.activate,
        startTurn: runtime || kimiRuntime ? ordinaryTurnDependencies.start : undefined,
        ensureWriter: ordinaryTurnDependencies.ensureWriter,
        releaseWriter: ordinaryTurnDependencies.releaseWriter,
        onTurnStarted: ordinaryTurnDependencies.onStarted,
        submitTurn: submitSessionTurn,
        agentActivity: (id) => activity.snapshot(id, new Date().toISOString()),
        toolEfficiency: (id) => toolEfficiency.snapshot(id),
        retrievalReadiness: (id) => runtime?.readRetrievalReadiness(id) ?? Promise.resolve(null),
        autopilotSnapshot: (id) => autopilot.snapshot(id),
        autopilotControlTurns: (id) => autopilot.acceptedControlTurns(id),
        autopilotAudit: (id, limit) => journal.autopilotAuditTail(id, limit),
        refreshActivity: (id) => activity.refresh(id),
        models,
        sessionModels,
        readHistory:
          runtime || kimiRuntime
            ? (session) => {
                const owner = ownerRuntime(session);
                if (!owner) return Promise.reject(new Error('LLM_RUNTIME_UNAVAILABLE'));
                return owner.readHistory(session);
              }
            : undefined,
        currentSequence: (sessionId) => journal.currentSequence(sessionId),
        activityHistory: (sessionId, throughSequence) =>
          journal.activityHistory(sessionId, throughSequence),
        interruptTurn:
          runtime || kimiRuntime
            ? (session, turnId) => {
                providerRecovery.cancel(session.id);
                const owner = ownerRuntime(session);
                return owner ? owner.interruptTurn(session, turnId) : Promise.resolve();
              }
            : undefined,
        queueTurnInput:
          runtime || kimiRuntime
            ? (session, turnId, text, clientUserMessageId) => {
                providerRecovery.cancel(session.id);
                autopilot.manualSend(session.id);
                const owner = ownerRuntime(session);
                if (!owner) return Promise.resolve();
                return owner.queueTurnInput(session, turnId, text, clientUserMessageId);
              }
            : undefined,
        restore:
          runtime || kimiRuntime
            ? async (session) => {
                const owner = ownerRuntime(session);
                if (!owner) throw new Error('LLM_RUNTIME_UNAVAILABLE');
                const restored = await owner.restoreWithOutcome(
                  await recoverExecutionPolicy(session),
                  new Date().toISOString(),
                );
                // An exit can be reported while resume is resolving. Do not let the
                // route persist a stale ready snapshot over that recovered exit.
                if (!owner.ownsWriter(session.id))
                  return {
                    ...restored,
                    session: RelaySession.rehydrate(restored.session).stop(new Date().toISOString())
                      .snapshot,
                  };
                return restored;
              }
            : undefined,
        ownsWriter: (id) => {
          const session = sessions.find(id);
          const owner = session ? ownerRuntime(session) : null;
          return owner ? owner.ownsWriter(id) : false;
        },
        promoteRecent:
          runtime || kimiRuntime
            ? (thread) =>
                promoteRecentThread(thread, {
                  createId: randomUUID,
                  now: () => new Date().toISOString(),
                  list: () => sessions.list(),
                  save: saveSession,
                  publish: (session) =>
                    withHistoryScratchContainment(session.workspacePath, () =>
                      saveSession(session),
                    ),
                  read: (session) => {
                    const owner = ownerRuntime(session);
                    if (!owner) throw new Error('LLM_RUNTIME_UNAVAILABLE');
                    return owner.readHistory(session);
                  },
                  executionPolicy: (candidate) =>
                    candidate.provider === 'kimi'
                      ? Promise.resolve(undefined)
                      : recentThreads.executionPolicy(candidate.id),
                })
            : undefined,
        release: (session) => {
          providerRecovery.cancel(session.id);
          autopilot.cancel(session.id, 'sessionEnded');
          return RelaySession.rehydrate(session).release(new Date().toISOString()).snapshot;
        },
        remove: (id) => {
          providerRecovery.cancel(id);
          autopilot.cancel(id, 'sessionEnded');
          activity.dispose(id);
          sessions.remove(id);
        },
        idempotency,
        close:
          runtime || kimiRuntime
            ? async (id) => {
                providerRecovery.cancel(id);
                autopilot.cancel(id, 'sessionEnded');
                await hostTests?.cancelSession(id);
                planMeasurementRefresh?.stop(id);
                dismissPendingInteractions(id, new Date().toISOString());
                activity.dispose(id);
                const session = sessions.find(id);
                const owner = session ? ownerRuntime(session) : null;
                if (session && owner) await owner.releaseForForget(session);
                await playwright.waitForRelease(id);
                const current = sessions.find(id);
                if (
                  current?.desiredState === 'stopped' &&
                  ['stopped', 'released'].includes(current.state)
                ) {
                  orgPlanLaunches.releaseSession(id);
                  takeoverStore.releaseSession(id);
                }
              }
            : undefined,
        replyInteraction:
          runtime || kimiRuntime
            ? async (sessionId, requestId, value) => {
                providerRecovery.cancel(sessionId);
                const session = sessions.find(sessionId);
                const owner = session ? ownerRuntime(session) : null;
                if (await owner?.resolveServerRequest(sessionId, requestId, value))
                  return 'accepted';
                // Codex reports false when its app-server has already cleared a
                // request. Kimi returns false for a failed provider delivery and
                // retains the pending request for retry.
                return session?.provider === 'kimi' ? 'unavailable' : 'cleared';
              }
            : undefined,
        interactionResolved: (sessionId, requestId, occurredAt, outcome) => {
          const remaining = blockingInteractions(sessionId);
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
      tmpCleanup: cleanTmp,
      sessionEvents: {
        exists: (id) => sessions.find(id) !== null,
        replay: (id, after) => {
          const started = performance.now();
          const result = journal.replay(id, after);
          transportDiagnostics.record(id, {
            kind: result.kind,
            after,
            durationMs: performance.now() - started,
            ...(result.kind === 'replay' ? { count: result.events.length } : {}),
          });
          return result;
        },
        subscribe: (id, listener) => events.subscribe(id, listener),
      },
      planRoutes: {
        exists: (id) => sessions.find(id) !== null,
        find: (id) => supervisedPlans.find(id),
        refresh: async (id) => {
          const refreshed = await planStatusSource.refresh(id);
          if (refreshed?.kind === 'updated') return refreshed.plan;
          return refreshed ? null : supervisedPlans.findCurrent(id);
        },
        open: async (id, planName) => {
          const session = sessions.find(id);
          if (!session) return { kind: 'missing' };
          const result = await workspacePlanCatalog.read(session.workspacePath, planName);
          if (result.kind === 'available') {
            const planPath = resolve(session.workspacePath, ...planName.split('/'));
            await planStatusSource.attach(
              session,
              planPath,
              (update) => acceptPlanUpdate(id, update),
              'display-open',
            );
          }
          return result;
        },
        removeStatus: (id) =>
          planStatusSource.remove(id, supervisedPlans.identity(id) ?? undefined),
        clear: (id) => supervisedPlans.clear(id),
        closed: (id) => {
          const session = sessions.find(id);
          if (session?.lastOrgPlan) {
            const updated = {
              ...session,
              lastOrgPlan: { ...session.lastOrgPlan, attached: false },
              updatedAt: new Date().toISOString(),
            };
            sessions.save(updated);
            events.publish(journal.append(id, 'session.updated', updated, updated.updatedAt));
          }
          autopilot.cancel(id, 'planRemoved');
          planMeasurementRefresh?.stop(id);
          const occurredAt = new Date().toISOString();
          events.publish(journal.append(id, 'plan.closed', {}, occurredAt));
        },
      },
      workspacePlanRoutes: { workspaces, plans: workspacePlanCatalog, archiver: planArchiver },
      prepareOrgPlanRoutes: { prepare: prepareOrgPlan },
      executeOrgPlanRoutes: { startOrgPlanSupervision: startPlanSupervision },
      downloadOrgPlanRoutes: {
        resolveReference: (reference) => orgPlanContext.resolveReference(reference),
        readSource: (workspacePath, planName) =>
          workspacePlanCatalog.readSource(workspacePath, planName),
      },
      workspaceFileRoutes: {
        workspaces,
        files: workspaceFiles,
        readLinkedFile: async (root, path) => {
          const preview = await workspaceFiles.read(path.startsWith('/') ? '/' : root, path);
          return preview.kind === 'available' && path.startsWith('/')
            ? { ...preview, preview: { ...preview.preview, path } }
            : preview;
        },
      },
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
            const interaction = pendingInteractionsWithReports(sessionId).find(
              (item) => item.kind === 'orgPlanAttention',
            );
            const attention = interaction ? parseOrgPlanAttention(interaction.payload) : null;
            return interaction && attention
              ? {
                  requestId: interaction.requestId,
                  turnId: interaction.turnId ?? null,
                  requestedAt: interaction.requestedAt ?? null,
                  attention,
                  ...(interaction.supervisorReport
                    ? { supervisorReport: interaction.supervisorReport }
                    : {}),
                }
              : null;
          },
        },
        resolver: attentionResolution,
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
    await hostTests?.close();
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
        if (forgetOperations.find(session.id)) return;
        // The status lease must repopulate the authoritative plan projection before
        // a durable coordinator is restored. Writer detachment is a process concern,
        // not a human disable: a later fenced continuation can reacquire it safely.
        if (session.desiredState === 'active') {
          saveSession(RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot);
          await (session.provider === 'kimi' ? kimiRuntime : runtime)?.release(session.id);
        }
        await runtime?.watchPlanStatus(session);
        autopilot.restore(session.id);
        // A prior process cannot resolve its original JSON-RPC request.  Turn
        // that bounded handoff into one durable failure and release the
        // checkpoint only through the explicit runtime-recovery boundary.
        checkpoints.failPending(session.id, true);
      },
    );
  };
  app.addHook('onListen', async () => {
    for (const id of forgetOperations.pendingIds())
      void forgetSessions.execute(id).catch(() => undefined);
    const profile = (await options.profiles.list()).find((item) => item.state === 'ok')?.name;
    if (profile) await editorSkillCatalog.refresh('codex', profile, root);
    // Kimi discovery owns a provider process, so passive relay startup must not
    // refresh it. Explicit session creation and user-requested skill refreshes
    // enter KimiSkillCatalog through their normal operation paths instead.
    // Rehydrate durable attachments even when this relay does not launch Codex writers.
    for (const session of sessions.list()) {
      if (forgetOperations.find(session.id)) continue;
      if (!persistedSessionIds.has(session.id) || session.provider === 'kimi') continue;
      if (session.lastOrgPlan?.attached && session.lastOrgPlan.path) {
        try {
          await planStatusSource.open(session, (update) => acceptPlanUpdate(session.id, update));
          if (!supervisedPlans.find(session.id)) {
            await planStatusSource
              .attach(
                session,
                session.lastOrgPlan.path,
                (update) => acceptPlanUpdate(session.id, update),
                'restored-attachment',
              )
              .catch(() => {});
          }
        } catch {
          /* Keep the durable assignment when its workspace is temporarily unavailable. */
        }
      }
    }
    await detachActiveSessions();
  });
  // HTTP close waits for accepted requests. A provider that never answers a
  // history RPC must not keep us from reaching the normal runtime cleanup.
  app.addHook('preClose', async () => {
    closing = true;
    providerRecovery.dispose();
    runtime?.cancelHistoryReads();
  });
  app.addHook('onClose', async () => {
    await hostTests?.close();
    await forgetSessions.drain();
    for (const [sessionId, timer] of capacityRecoveryTimers) {
      clearTimeout(timer);
      capacityRecoveries.delete(sessionId);
    }
    capacityRecoveryTimers.clear();
    // Capacity recovery owns an app-server recycle that can still persist its
    // result after an await. Drain accepted operations before stopping runtimes
    // or closing the session database they use.
    await Promise.allSettled([...capacityRecoveryTasks.values()]);
    planMeasurementRefresh?.stopAll();
    for (const session of sessions.list()) {
      autopilot.dispose(session.id);
      activity.dispose(session.id);
      checkpoints.disposeSession(session.id);
      attentionAcknowledgement.disposeSession(session.id);
      // Relay shutdown only releases this process's writer.  A typed attention
      // request remains a durable human-visible blocker for the next relay
      // instance; only an app-server-cleared request is a failed audit outcome.
      for (const interaction of interactions.list(session.id)) {
        // Checkpoints are recovered by the next relay: their original root
        // boundary is durable and must not be replaced by a shutdown dismissal.
        if (interaction.kind === 'orgPlanAttention' || interaction.kind === 'orgPlanCheckpoint')
          continue;
        const occurredAt = new Date().toISOString();
        if (interactions.resolve(session.id, interaction.requestId, occurredAt, 'dismissed'))
          publishInteractionResolved(session.id, interaction.requestId, occurredAt, 'dismissed');
      }
    }
    runtime?.stopAll();
    await runtime?.drainReleases();
    kimiRuntime?.stopAll();
    await kimiManager?.stopAll();
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

function checkpointFailureResponse(
  reasonCode: string,
  details: Readonly<{
    expected?: Readonly<Record<string, string | boolean | null>>;
    observed?: Readonly<Record<string, string | boolean | null>>;
  }> = {},
) {
  const correlationId = randomUUID();
  checkpointDiagnostic('%o', { correlationId, reasonCode, ...details });
  return toOrgPlanCheckpointToolResponse('failed', { reasonCode, correlationId, ...details });
}
