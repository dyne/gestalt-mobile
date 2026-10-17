/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { SessionRepository } from '../../features/sessions/application/ports.js';
import { CodexJsonRpcError, CodexLiveContextProbeError } from '../codex/json-rpc-client.js';
import type { LiveControls } from '../../features/live-design/application/controls.js';
import type {
  LiveRun,
  LiveStartClaim,
  LiveFence,
} from '../../features/live-design/application/ownership.js';
import type {
  LiveLifecycleRequest,
  PreviewGrantDependencies,
  PreviewRevocationScope,
} from '../../features/live-design/application/ports.js';
import { startLive, type LiveStartRequest } from '../../features/live-design/start/use-case.js';
import { stopLive } from '../../features/live-design/stop/use-case.js';
import { resumeLive } from '../../features/live-design/resume/use-case.js';
import type { LivePollLoop } from '../../features/live-design/application/poll-loop.js';
import type {
  CanonicalLivePoll,
  LiveEventInbox,
} from '../../features/live-design/application/poll-events.js';
import { CodexSessionRuntime, type AppServerLaunchInput } from '../codex/session-runtime.js';
import { launchCodexAppServer } from '../codex/codex-process-launcher.js';
import { electLiveController } from './elected-controller.js';
import { prepareHelperOutputRoots } from './helper-control-layout.js';
import {
  liveAppIdentity,
  revalidateLiveApp,
  type SqliteLiveOwnership,
} from './sqlite-live-ownership.js';
import { LiveDispatchGuard } from './live-dispatch.js';
import {
  readProductionLiveConfiguration,
  type ProductionLiveConfiguration,
} from './production-configuration.js';
import {
  assertProductionSourceObservation,
  prepareProductionPolicy,
  type PreparedProductionPolicy,
} from './production-policy.js';
import {
  readLiveConfigFile,
  resolveLiveConfigFiles,
  type LiveConfigFile,
} from './effective-config.js';
import {
  livePolicyAppConfined,
  normalizedLivePermissions,
  owningPermissions,
} from './owning-permissions.js';
import {
  InstalledLiveAdmissionError,
  InstalledLivePolicy,
  measureInstalledLiveTree,
} from './installed-policy.js';
import {
  IsolatedProjectProcess,
  type IsolatedProjectReceipt,
  type IsolatedProjectSpecification,
} from './isolated-project-process.js';
import { ConnectionFileVerification } from './process-identity.js';
import { IsolatedLiveHelper } from './isolated-live-helper.js';
import { CaddyRouteStore } from './caddy-route-store.js';
import { CaddyRoutes } from './caddy-routes.js';
import { CaddyRouteBroker } from './caddy-route-broker.js';
import { ManagedCaddyAdminBoundary } from './caddy-admin-boundary.js';
import { UnixCaddyAdmin } from './caddy-admin.js';
import { RegisteredPreviewTargets } from './preview-targets.js';
import { createPreviewGateway } from './preview-gateway.js';
import { isolatedPreviewUpstreams } from './isolated-preview-upstreams.js';
import { PreviewConnections } from './preview-connections.js';
import { SqliteLiveEventInbox } from './sqlite-event-inbox.js';
import { captureOwningRuntime, type OwningRuntimeCapture } from './owning-runtime-capture.js';
import { assertLiveNativeInstallation } from './native-contract.js';
import { validateOriginalLaunchSources } from './original-launch-sources.js';
import {
  assertOriginalLiveMcp,
  assertAdmittedLiveMcp,
  originalLaunchSurfaces,
} from './installed-launch-contract.js';
import { observeOwningNative } from './owning-observation.js';
import { currentOwningSession, recoveredSession } from './recovered-session.js';
import {
  captureLiveInjection,
  verifyLiveInjectionRemoved,
  type LiveInjectionArtifacts,
} from './injection-cleanup.js';

type Observation = Awaited<ReturnType<CodexSessionRuntime['inspectLiveAdmission']>>;
type App = ProductionLiveConfiguration['apps'][number];
type Generation = {
  app: App;
  session: RelaySessionSnapshot;
  observation: Observation;
  plannedGeneration: number;
  policy: PreparedProductionPolicy;
  helper: IsolatedProjectProcess;
  helperReceipt: IsolatedProjectReceipt;
  devserver: IsolatedProjectProcess;
  devReceipt: IsolatedProjectReceipt;
  claim: LiveStartClaim;
  run?: LiveRun;
  cli?: IsolatedLiveHelper;
  gateway?: Awaited<ReturnType<typeof createPreviewGateway>>;
  registrationId?: string;
  loop?: LivePollLoop;
  inbox?: SqliteLiveEventInbox;
  resumed: boolean;
  injected: boolean;
  injectionArtifacts?: LiveInjectionArtifacts;
  retired: boolean;
  replacementRestored?: boolean;
};
export type ProductionLiveBindings = {
  runtime: CodexSessionRuntime;
  sessions: SessionRepository;
  guard: LiveDispatchGuard;
  saveSession(session: RelaySessionSnapshot): void;
  settleAuxiliary(): Promise<void>;
  authenticationDirectory: string;
};

/** Sole production controller. Public inputs select registered IDs, never
 * commands, paths, URLs, PIDs, configuration, launch policies or receipts.
 */
export class ProductionLiveController {
  private bindings?: ProductionLiveBindings;
  private controls?: LiveControls;
  private preview?: PreviewGrantDependencies;
  private connections?: PreviewConnections;
  private pollFactory?: (cli: CanonicalLivePoll, inbox: LiveEventInbox) => LivePollLoop;
  private readonly scopesBySession = new Map<string, readonly string[]>();
  private readonly generations = new Map<string, Generation>();
  private readonly preflight = new Set<string>();
  private readonly failedPreparations = new Set<string>();
  private readonly targets = new RegisteredPreviewTargets();
  private readonly captures = new Map<string, OwningRuntimeCapture>();
  private readonly revokedCaptures = new Set<string>();
  private readonly pendingLaunches = new Map<string, OwningRuntimeCapture>();
  private readonly renewalLaunches = new Map<
    string,
    {
      capture: OwningRuntimeCapture;
      fence: LiveFence;
      threadConfig: Readonly<Record<string, unknown>>;
    }
  >();
  private readonly capturedProcesses = new Map<string, ReturnType<typeof launchCodexAppServer>>();
  private readonly preparedOwners = new Map<string, PreparedProductionPolicy>();
  private readonly originalObservations = new Map<string, Observation>();
  private readonly privateOwners = new Set<string>();
  private readonly construction = new AsyncLocalStorage<{ sessionId: string; active: boolean }>();
  private readonly origins: CaddyRouteStore;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    readonly owners: SqliteLiveOwnership,
    private readonly cfg: ProductionLiveConfiguration,
    private readonly source: LiveConfigFile,
    private readonly releaseElection: () => Promise<void>,
    private readonly election: Awaited<ReturnType<typeof electLiveController>>['election'],
  ) {
    this.cfg = structuredClone(cfg);
    this.origins = new CaddyRouteStore(
      join(cfg.privateDirectory, 'routes.sqlite'),
      cfg.caddy.hostname,
      cfg.caddy.previewPorts,
      { initialize: true },
    );
  }
  bindControls(controls: LiveControls): void {
    this.controls = controls;
  }
  bindPollLoop(create: (cli: CanonicalLivePoll, inbox: LiveEventInbox) => LivePollLoop): void {
    this.pollFactory = (cli, inbox) =>
      create(
        {
          status: () => cli.status(),
          poll: async () => {
            const g = [...this.generations.values()].find((candidate) => candidate.cli === cli);
            const run = g?.run && this.owners.current(g.run.liveId);
            if (!g || !run || run.state !== 'active' || run.generation !== g.plannedGeneration)
              throw new Error('LIVE_GENERATION_STALE');
            await this.requireBindings().runtime.inspectLiveQuiescence(g.session);
            this.owners.assert(run);
            return cli.poll();
          },
          reply: (reply) => cli.reply(reply),
          complete: (id, discarded) => cli.complete(id, discarded),
          settle: (run) =>
            cli.settle ? cli.settle(run) : Promise.reject(new Error('LIVE_SETTLEMENT_UNAVAILABLE')),
        },
        inbox,
      );
  }
  bindProduction(
    bindings: ProductionLiveBindings,
    preview: PreviewGrantDependencies,
    connections: PreviewConnections,
  ): void {
    if (this.bindings) throw new Error('LIVE_CONTROLLER_ALREADY_BOUND');
    this.bindings = bindings;
    this.preview = preview;
    this.connections = connections;
  }
  scopes = (session: RelaySessionSnapshot): readonly string[] | null =>
    this.scopesBySession.get(session.id) ?? null;
  preflightBlocked = (): boolean => this.preflight.size > 0 || this.failedPreparations.size > 0;
  auxiliaryConstructionAllowed = (): boolean => {
    const owner = this.construction.getStore();
    return !!owner?.active && !this.captures.has(owner.sessionId);
  };
  supportsOwningStartup = (session: RelaySessionSnapshot): boolean => {
    const app = this.cfg.apps.find((item) => item.appRoot === session.workspacePath);
    const selected = session.executionPolicy?.sandbox;
    return (
      !!app?.owningPolicy &&
      session.provider === 'codex' &&
      (!selected || (selected === 'workspace-git' && app.owningPolicy.profileId === selected))
    );
  };
  /** Release only after revocation and the exact owned child lifetime have settled. */
  async releaseFailedStartup(session: RelaySessionSnapshot): Promise<void> {
    if (!this.supportsOwningStartup(session)) return;
    const b = this.requireBindings();
    const capture = this.captures.get(session.id);
    try {
      if (capture) {
        await this.revokeCapture(capture);
        const child = this.capturedProcesses.get(capture.captureId);
        if (child) {
          child.close();
          if (!child.waitForExit) throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              child.waitForExit(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('LIVE_PROCESS_TREE_UNVERIFIED')), 10000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      await b.settleAuxiliary();
      if (this.failedPreparations.has(session.id)) throw new Error('LIVE_CLEANUP_REQUIRED');
      b.guard.settle(session.id, {
        roots: 0,
        descendants: 0,
        commands: 0,
        approvals: 0,
        unknown: false,
      });
    } catch (error) {
      this.failedPreparations.add(session.id);
      throw error;
    }
  }
  withOwningAdmission = async <T>(
    session: RelaySessionSnapshot,
    work: () => Promise<T>,
  ): Promise<T> => {
    const app = this.cfg.apps.find((item) => item.appRoot === session.workspacePath);
    if (!app?.owningPolicy || session.provider !== 'codex' || this.captures.has(session.id))
      return work();
    const b = this.requireBindings();
    b.guard.writer(session);
    this.preflight.add(session.id);
    const authority = { sessionId: session.id, active: true };
    try {
      await b.settleAuxiliary();
      const peers = b.runtime.liveOwnerIds().filter((id) => id !== session.id);
      for (const id of peers) {
        const peer = b.sessions.find(id);
        if (!peer || !this.privateOwners.has(id)) throw new Error('LIVE_SESSION_BUSY');
        await b.runtime.inspectLiveQuiescence(peer);
      }
      this.owners.assertCaptureWriters(session.id, peers);
      return await this.construction.run(authority, () => b.guard.livePreparation(session, work));
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'LIVE_RUNTIME_CAPTURE_CLEANUP_REQUIRED'
      )
        this.failedPreparations.add(session.id);
      const capture = this.captures.get(session.id);
      if (capture)
        try {
          await this.revokeCapture(capture);
        } catch {
          this.failedPreparations.add(session.id);
        }
      throw error;
    } finally {
      authority.active = false;
      this.preflight.delete(session.id);
    }
  };
  private verifyHost(): void {
    if (this.closed || readLiveConfigFile(this.source.path).sha256 !== this.source.sha256)
      throw new Error('LIVE_CONFIG_CHANGED');
    const running = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    if (
      running !== this.cfg.mobile.root ||
      measureInstalledLiveTree(running) !== this.cfg.mobile.sha256
    )
      throw new Error('LIVE_MOBILE_COMPONENT_UNVERIFIED');
    new InstalledLivePolicy(this.cfg.installation).validateInstallation();
    assertLiveNativeInstallation(this.cfg.native.path);
  }
  launchNative(input: AppServerLaunchInput) {
    this.verifyHost();
    for (const app of this.cfg.apps)
      if (app.owningPolicy)
        validateOriginalLaunchSources({
          owningHome: this.cfg.nativeEnvironment.CODEX_HOME,
          files: app.owningPolicy.configFiles,
          installedSource: app.owningPolicy.originalLaunchSources?.[0],
          threadConfig: {},
        });
    const capture = input.liveCaptureId ? this.pendingLaunches.get(input.liveCaptureId) : undefined;
    if (input.liveCaptureId && !capture) throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
    if (capture) this.pendingLaunches.delete(capture.captureId);
    const environment: Record<string, string> = { ...this.cfg.nativeEnvironment };
    environment.PATH = `${dirname(this.cfg.installation.node.path)}:${dirname(this.cfg.native.path)}:${environment.PATH}`;
    for (const name of this.cfg.providerCredentialEnvironment) {
      // Forward only explicit host-authorized standard bindings; never discover
      // credentials or read unrelated credential/configuration files.
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    const nativeProcess = launchCodexAppServer(input, {
      executable: this.cfg.native.path,
      sha256: this.cfg.native.sha256,
      environment,
      managedLaunch: {
        command: this.cfg.installation.manager.path,
        args: capture
          ? [
              'cli',
              '--',
              '--live-policy-owning-runtime',
              '--manifest',
              capture.manifestPath,
              '--capture-id',
              capture.captureId,
            ]
          : ['cli', '--', 'app-server', '--stdio'],
      },
    });
    if (capture) this.capturedProcesses.set(capture.captureId, nativeProcess);
    return nativeProcess;
  }
  prepareOwningLaunch = async (
    session: RelaySessionSnapshot,
    input: AppServerLaunchInput,
    modelConfig: Readonly<Record<string, unknown>>,
  ): Promise<AppServerLaunchInput> => {
    const app = this.cfg.apps.find((item) => item.appRoot === session.workspacePath);
    if (!app?.owningPolicy || session.provider !== 'codex') return input;
    const selected = session.executionPolicy?.sandbox;
    if (selected && (selected !== 'workspace-git' || app.owningPolicy.profileId !== selected))
      return input;
    const previous = this.captures.get(session.id);
    const renewed = this.renewalLaunches.get(session.id);
    if (renewed) {
      const run = this.owners.assert(renewed.fence);
      if (
        run.state !== 'starting' ||
        run.phase !== 'resume:prepare:intent' ||
        run.rootThreadId !== session.threadId ||
        previous !== renewed.capture ||
        !isDeepStrictEqual(modelConfig, renewed.threadConfig) ||
        !this.pendingLaunches.has(renewed.capture.captureId)
      )
        throw new Error('LIVE_RUNTIME_RENEWAL_INVALID');
      this.renewalLaunches.delete(session.id);
      return { ...input, liveCaptureId: renewed.capture.captureId };
    }
    if (previous) {
      if (this.revokedCaptures.has(previous.captureId)) return input; // Normal restored chat has no Live admission.
      throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
    }
    this.verifyHost();
    const b = this.requireBindings();
    await b.settleAuxiliary();
    this.owners.assertCaptureWriters(
      session.id,
      b.runtime.liveOwnerIds().filter((id) => id !== session.id && this.privateOwners.has(id)),
    );
    const generation = this.owners.reserveAdmissionGeneration(session.id, app.appRoot);
    const capture = await captureOwningRuntime({
      configuration: this.cfg,
      app,
      session,
      election: this.election,
      generation,
      authenticationDirectory: b.authenticationDirectory,
      threadConfig: modelConfig,
    });
    this.captures.set(session.id, capture);
    this.pendingLaunches.set(capture.captureId, capture);
    return { ...input, liveCaptureId: capture.captureId };
  };
  validateOriginalThreadFlags = (
    session: RelaySessionSnapshot,
    modelConfig: Readonly<Record<string, unknown>>,
  ): void => {
    const capture = this.captures.get(session.id);
    if (!capture || this.revokedCaptures.has(capture.captureId)) return;
    const app = this.cfg.apps.find((item) => item.appRoot === session.workspacePath);
    if (!app?.owningPolicy) throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    validateOriginalLaunchSources({
      owningHome: this.cfg.nativeEnvironment.CODEX_HOME,
      files: app.owningPolicy.configFiles,
      installedSource: app.owningPolicy.originalLaunchSources?.[0],
      threadConfig: modelConfig,
    });
  };
  private requireBindings() {
    if (!this.bindings || !this.controls || !this.preview || !this.connections || !this.pollFactory)
      throw new Error('LIVE_DEPENDENCIES_UNAVAILABLE');
    return this.bindings;
  }
  private appFor(session: RelaySessionSnapshot, appId?: string, targetId?: string): App {
    const app = this.cfg.apps.find(
      (item) =>
        item.appRoot === session.workspacePath &&
        (!appId || item.appId === appId) &&
        (!targetId || item.targetId === targetId),
    );
    if (!app || session.provider !== 'codex' || !session.threadId)
      throw new Error(
        session.provider !== 'codex' ? 'LIVE_PROVIDER_UNSUPPORTED' : 'LIVE_TARGET_UNREGISTERED',
      );
    return app;
  }
  private originalSurfaces(app: App, threadConfig: Readonly<Record<string, unknown>>) {
    if (!app.owningPolicy) throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    const source = app.owningPolicy.originalLaunchSources?.[0];
    return originalLaunchSurfaces(
      source,
      validateOriginalLaunchSources({
        owningHome: this.cfg.nativeEnvironment.CODEX_HOME,
        files: app.owningPolicy.configFiles,
        installedSource: source,
        threadConfig,
      }).plugins,
    );
  }
  /** Called after actual native start/resume, before exposing ordinary writer readiness. */
  async observeOwnerStarted(session: RelaySessionSnapshot): Promise<void> {
    if (this.generations.has(session.id) || this.preparedOwners.has(session.id)) return;
    let mcpDiagnostic: unknown;
    try {
      const bindings = this.requireBindings();
      const app = this.appFor(session);
      const observation = await bindings.runtime.inspectLiveAdmission(session);
      const protectedPaths = [
        this.cfg.privateDirectory,
        bindings.authenticationDirectory,
        this.cfg.nativeEnvironment.CODEX_HOME,
        this.cfg.caddy.controllerDirectory,
        `/tmp/codex-daemon-${process.getuid!()}`,
        '/proc',
      ];
      const files = resolveLiveConfigFiles({
        configuration: observation.configuration,
        appRoot: app.appRoot,
        capturedProjectSources: this.captures.get(session.id)?.captured.directories,
        threadConfig: observation.threadConfig,
        approved: this.originalSurfaces(app, observation.threadConfig),
      });
      assertOriginalLiveMcp(observation.mcp, app.owningPolicy?.originalLaunchSources?.[0]);
      const { state } = owningPermissions({
        session,
        observation,
        appRoot: app.appRoot,
        protectedPaths,
      });
      const capture = this.captures.get(session.id);
      if (
        capture &&
        (!isDeepStrictEqual(
          normalizedLivePermissions(state),
          normalizedLivePermissions(capture.baselineState),
        ) ||
          !isDeepStrictEqual(
            [...files].sort((a, b) => a.path.localeCompare(b.path)),
            [...(app.owningPolicy?.configFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
          ))
      )
        throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
      if (capture && !this.revokedCaptures.has(capture.captureId)) {
        const policy = await prepareProductionPolicy({
          configuration: this.cfg,
          source: this.source,
          session,
          observation,
          app,
          directory: capture.directory,
          authenticationDirectory: bindings.authenticationDirectory,
          capture,
          reconfigure: (modelConfig) =>
            bindings.runtime.reconfigureLiveOwner(session, {
              modelConfig,
              skillsConfig: observation.skillsConfig,
            }),
          observe: () => bindings.runtime.inspectLiveAdmission(session),
        });
        const current = await bindings.runtime.inspectLiveAdmission(session);
        assertProductionSourceObservation(policy, current);
        const tools = current.mcp as {
          data?: {
            name: string;
            runtimeStatus?: string;
            toolsError?: unknown;
            httpOrigin?: unknown;
          }[];
          nextCursor?: unknown;
        };
        mcpDiagnostic = {
          count: Array.isArray(tools.data) ? tools.data.length : null,
          paginated: Boolean(tools.nextCursor),
          servers: Array.isArray(tools.data)
            ? tools.data.slice(0, 4).map((tool) => ({
                name: ['context-mode', 'gestalt-org-plan'].includes(tool.name)
                  ? tool.name
                  : 'unapproved',
                status: [
                  'notStarted',
                  'starting',
                  'connected',
                  'authenticationRequired',
                  'failed',
                  'cancelled',
                  'disabled',
                ].includes(tool.runtimeStatus ?? '')
                  ? tool.runtimeStatus
                  : 'unrecognized',
                toolsError: Boolean(tool.toolsError),
                errorMarkers:
                  typeof tool.toolsError === 'string'
                    ? [
                        'closed',
                        'connection',
                        'initialize',
                        'timed out',
                        'timeout',
                        'unexpected',
                        'not initialized',
                        'unauthorized',
                        'receipt',
                        'admission',
                        'context-call-unavailable',
                        'live-tool-unavailable',
                        'invalid-native-response',
                        'native-worker-active',
                        'tools/list',
                        'transport',
                      ].filter((marker) => String(tool.toolsError).toLowerCase().includes(marker))
                    : [],
                httpOrigin: Boolean(tool.httpOrigin),
              }))
            : [],
        };
        assertAdmittedLiveMcp(current.mcp);
        this.preparedOwners.set(session.id, policy);
        this.originalObservations.set(session.id, observation);
      }
      this.privateOwners.add(session.id);
      if (!livePolicyAppConfined(state, app.appRoot)) {
        this.scopesBySession.delete(session.id);
        return; // The actual existing unknown/global reservation remains held.
      }
      const scopes = [
        ...new Set(
          state.permissionProfile.file_system.entries.flatMap((entry) =>
            entry.access === 'write' && entry.path.type === 'path'
              ? [
                  lstatSync(entry.path.path).isDirectory()
                    ? entry.path.path
                    : dirname(entry.path.path),
                ]
              : [],
          ),
        ),
      ];
      const idle = await bindings.runtime.inspectLiveQuiescence(session);
      bindings.guard.narrowQuiescentWriter(session.id, scopes, idle.outstanding);
      this.scopesBySession.set(session.id, scopes);
    } catch (error) {
      // Ordinary workflows remain usable under an unknown/global reservation.
      // Start repeats the full admission checks and cannot acquire authority here.
      this.scopesBySession.delete(session.id);
      const capture = this.captures.get(session.id);
      if (capture && !this.revokedCaptures.has(capture.captureId)) {
        try {
          const native =
            error instanceof CodexJsonRpcError
              ? {
                  method: error.liveRpcMethod ?? 'unknown',
                  code: error.code,
                  kind: error.kind,
                  closing:
                    error.message ===
                    `thread ${session.threadId} is closing; retry thread/resume after the thread is closed`,
                  rolloutMentioned: /\brollout\b/i.test(error.message),
                  markers: error.liveDiagnosticMarkers,
                }
              : undefined;
          writeFileSync(
            join(this.cfg.privateDirectory, `preparation-failure-${randomUUID()}.json`),
            JSON.stringify({
              stage: 'original-startup-admission',
              error: native
                ? 'LIVE_NATIVE_STARTUP_UNAVAILABLE'
                : error instanceof Error && /^LIVE_[A-Z0-9_]+$/.test(error.message)
                  ? error.message
                  : 'LIVE_STARTUP_UNAVAILABLE',
              native,
              mcp: mcpDiagnostic,
            }) + '\n',
            { mode: 0o600, flag: 'wx' },
          );
        } catch {
          /* Bounded diagnostics cannot waive failure or block revocation. */
        }
        try {
          await this.revokeCapture(capture);
        } catch {
          this.failedPreparations.add(session.id);
        }
        // Captured owners must pass before ordinary writer readiness.
        throw error instanceof CodexJsonRpcError
          ? new Error('LIVE_NATIVE_STARTUP_UNAVAILABLE', { cause: error })
          : error;
      }
    }
  }
  targetsFor(session: RelaySessionSnapshot): readonly { appId: string; targetId: string }[] {
    if (session.provider !== 'codex') return [];
    return this.cfg.apps
      .filter((app) => app.appRoot === session.workspacePath)
      .map(({ appId, targetId }) => ({ appId, targetId }));
  }
  targetsForRelay(relayId: string): readonly { appId: string; targetId: string }[] {
    const session = this.requireBindings().sessions.find(relayId);
    return session ? this.targetsFor(session) : [];
  }
  start(request: LiveStartRequest): Promise<LiveRun> {
    return this.serialize(async () => {
      const bindings = this.requireBindings();
      this.verifyHost();
      if (this.failedPreparations.size) throw new Error('LIVE_CLEANUP_REQUIRED');
      const session = bindings.sessions.find(request.relayId);
      if (!session) throw new Error('LIVE_SESSION_UNAVAILABLE');
      const app = this.appFor(session, request.appId, request.targetId);
      if (
        !this.preview!.authentication.authorized(
          request.authSessionHash,
          request.deviceId,
          this.preview!.now().toISOString(),
        )
      )
        throw new Error('LIVE_AUTH_UNAVAILABLE');
      const existing = this.owners.read(session.id);
      if (existing) {
        if (
          existing.operationId !== request.operationId ||
          existing.appId !== app.appId ||
          existing.targetId !== app.targetId ||
          existing.authSessionHash !== request.authSessionHash ||
          existing.deviceId !== request.deviceId
        )
          throw new Error('LIVE_MODE_ACTIVE');
        await this.verifyLiveRuntime(existing);
        return this.owners.assert(existing);
      }
      this.preflight.add(session.id);
      let lifecycleStage = 'register';
      const operation = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
        lifecycleStage = stage;
        try {
          return await work();
        } catch (error) {
          this.recordStartFailure(session.id, 'start-operation', stage, error);
          throw error;
        }
      };
      try {
        const previous = this.generations.get(session.id);
        if (previous?.retired && this.revokedCaptures.has(previous.policy.capture.captureId)) {
          lifecycleStage = 'renew-stopped-owner';
          await this.renewStoppedOwner(session, app, previous);
        }
        const run = await startLive(
          {
            owners: this.owners,
            controls: this.controls!,
            revalidateApp: revalidateLiveApp,
            admission: {
              register: () => operation('register', () => this.register(session, app, request)),
              unregister: (claim) => this.unregister(claim),
              busy: () =>
                operation('owning-quiescence', async () => {
                  await bindings.runtime.inspectLiveQuiescence(session);
                  return false;
                }),
              verify: (candidate) =>
                operation('generation-verification', () => this.verifyGeneration(candidate)),
            },
            resources: {
              quiesce: (candidate) =>
                operation('resource-quiescence', async () => {
                  const g = this.generation(candidate);
                  await bindings.runtime.inspectLiveQuiescence(g.session);
                }),
              restore: (candidate) => this.restoreOriginal(candidate),
              prepare: (candidate) =>
                operation('helper-and-context-preparation', () => this.prepareOwner(candidate)),
              cleanup: (candidate) => this.cleanup(candidate),
              authorize: (candidate) => operation('authorization', () => this.authorize(candidate)),
              revoke: (candidate) => this.revoke(candidate),
              expose: (candidate) => operation('preview-exposure', () => this.expose(candidate)),
              remove: (candidate) => this.remove(candidate),
            },
          },
          request,
        );
        const generation = this.generation(run);
        generation.run = run;
        generation.inbox = this.openInbox(run);
        generation.loop = this.pollFactory!(generation.cli!, generation.inbox);
        // The sole durable poll owner is the production composition's existing dispatcher.
        void generation.loop.run(run).catch(() => {});
        return run;
      } catch (error) {
        this.recordStartFailure(session.id, 'start-lifecycle', lifecycleStage, error);
        let recoveryRequired = false;
        try {
          recoveryRequired = this.owners.read(session.id)?.state === 'recoveryRequired';
        } catch {
          recoveryRequired = true;
        }
        if (recoveryRequired) {
          this.failedPreparations.add(session.id);
          throw new Error('LIVE_CLEANUP_REQUIRED');
        }
        throw error;
      } finally {
        this.preflight.delete(session.id);
      }
    });
  }
  private lifecycleRun(request: LiveLifecycleRequest): LiveRun {
    const run = this.owners.current(request.liveId);
    if (!run || run.relayId !== request.relayId || run.generation !== request.generation)
      throw new Error('LIVE_GENERATION_STALE');
    if (
      run.authSessionHash !== request.authSessionHash ||
      run.deviceId !== request.deviceId ||
      !this.preview!.authentication.authorized(
        request.authSessionHash,
        request.deviceId,
        this.preview!.now().toISOString(),
      )
    )
      throw new Error('LIVE_AUTH_UNAVAILABLE');
    return this.owners.assert(run);
  }
  private async renewStoppedOwner(
    session: RelaySessionSnapshot,
    app: App,
    previous: Generation,
  ): Promise<void> {
    const b = this.requireBindings();
    if (!previous.run || this.owners.current(previous.run.liveId)?.state !== 'idle')
      throw new Error('LIVE_CLEANUP_REQUIRED');
    this.owners.assertRestorable(this.owners.current(previous.run.liveId)!);
    b.guard.reacquirePreparation(session);
    const generation = this.owners.reserveAdmissionGeneration(session.id, app.appRoot);
    let capture: OwningRuntimeCapture | undefined;
    try {
      await b.guard.livePreparation(session, async () => {
        await b.runtime.inspectLiveQuiescence(session);
        const observation = await b.runtime.inspectLiveAdmission(session);
        const original = observeOwningNative({
          configuration: previous.observation.configuration,
          selection: previous.observation.threadSelection,
          account: previous.observation.account,
        });
        if (
          !isDeepStrictEqual(
            original,
            observeOwningNative({
              configuration: observation.configuration,
              selection: observation.threadSelection,
              account: observation.account,
            }),
          )
        )
          throw new Error('LIVE_RUNTIME_IDENTITY_CHANGED');
        capture = await captureOwningRuntime({
          configuration: this.cfg,
          app,
          session,
          election: this.election,
          generation,
          authenticationDirectory: b.authenticationDirectory,
          threadConfig: observation.threadConfig,
          renewal: { previous: previous.policy.capture, mode: 'survivor' },
        });
        this.captures.set(session.id, capture);
        const native = this.capturedProcesses.get(previous.policy.capture.captureId);
        if (!native) throw new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
        this.capturedProcesses.set(capture.captureId, native);
        const prepared = await prepareProductionPolicy({
          configuration: this.cfg,
          source: this.source,
          session,
          observation,
          app,
          directory: capture.directory,
          authenticationDirectory: b.authenticationDirectory,
          capture,
          reconfigure: (modelConfig) =>
            b.runtime.reconfigureLiveOwner(session, {
              modelConfig,
              skillsConfig: observation.skillsConfig,
            }),
          observe: () => b.runtime.inspectLiveAdmission(session),
        });
        this.preparedOwners.set(session.id, prepared);
        this.originalObservations.set(session.id, observation);
      });
    } catch (error) {
      if (capture) await this.revokeCapture(capture);
      this.failedPreparations.add(session.id);
      throw error;
    }
  }
  stop(request: LiveLifecycleRequest): Promise<LiveRun> {
    return this.serialize(async () => {
      const run = this.lifecycleRun(request);
      if (run.state === 'recoveryRequired' || run.state === 'error')
        await this.cleanupGeneration(run).loop?.waitForRecoveryDrain(run);
      return stopLive(
        {
          owners: this.owners,
          controls: this.controls!,
          resources: {
            revoke: (current) => this.revoke(current),
            settle: async (current) => {
              const g = this.cleanupGeneration(current);
              await g.loop?.drain(current);
              await this.settleOwningProcess(current);
              await this.reconcileInbox(current);
            },
            remove: (current) => this.remove(current),
            cleanup: (current) => this.cleanup(current, true),
            verifyClean: (current) => this.verifyClean(current),
            restore: (current) => this.restoreOriginal(current),
          },
        },
        run,
      );
    });
  }
  resume(request: LiveLifecycleRequest): Promise<LiveRun> {
    return this.serialize(async () => {
      const run = this.lifecycleRun(request);
      if (run.state === 'recoveryRequired' || run.state === 'error')
        await this.cleanupGeneration(run).loop?.waitForRecoveryDrain(run);
      const resumed = await resumeLive(
        {
          owners: this.owners,
          resources: {
            revoke: (current) => this.revoke(current),
            settle: async (current) => {
              const g = this.cleanupGeneration(current);
              await g.loop?.drain(current);
              await this.settleOwningProcess(current);
            },
            reconcileJournal: async (current) => {
              await this.reconcileInbox(current);
            },
            reconcileRoutes: async (current) => {
              await this.remove(current);
              await this.cleanup(current, true);
            },
            verify: async (current) => {
              if (current.state === 'starting') await this.verifyGeneration(current);
              else {
                await this.verifyClean(current);
                if (this.requireBindings().runtime.liveOwnerIds().includes(current.relayId))
                  await this.restoreOriginal(current);
                else await this.settleOwningProcess(current);
              }
            },
            prepare: (current) => this.renewGeneration(current),
            authorize: async (current) => {
              await this.prepareOwner(current);
              await this.authorize(current);
            },
            expose: (current) => this.expose(current),
          },
        },
        run,
      ).catch((error: unknown) => {
        this.recordStartFailure(run.relayId, 'resume-lifecycle', 'resume', error);
        throw error;
      });
      const g = this.generation(resumed);
      if (g.replacementRestored) {
        try {
          const b = this.requireBindings();
          b.saveSession(
            recoveredSession(
              currentOwningSession(g.session, b.sessions.find(resumed.relayId)),
              g.session,
            ),
          );
        } catch (error) {
          const failed = this.owners.mutate(resumed, {
            event: 'recover',
            code: 'LIVE_RELAY_RECOVERY_UNVERIFIED',
          });
          await this.revoke(failed);
          throw error;
        }
      }
      g.inbox = this.openInbox(resumed);
      g.loop = this.pollFactory!(g.cli!, g.inbox);
      void g.loop.run(resumed).catch(() => {});
      this.failedPreparations.delete(resumed.relayId);
      return resumed;
    });
  }
  private async verifyClean(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run);
    if (
      !g.retired ||
      g.injected ||
      g.gateway ||
      g.registrationId ||
      [g.helper, g.devserver].some((child) => {
        const proof = child.diagnostics();
        return !proof.namespaceExited || !proof.pipeDescriptorsClosed;
      }) ||
      existsSync(join(g.app.appRoot, '.impeccable/live/inject-journal.json')) ||
      existsSync(join(g.app.appRoot, '.impeccable/live/server.json'))
    )
      throw new Error('LIVE_CLEANUP_REQUIRED');
    const route = this.origins.read(g.app.appRoot);
    const actual = await new UnixCaddyAdmin(this.cfg.caddy.socketPath).request(
      'GET',
      '/config/apps/http/servers',
    );
    this.owners.assert(run);
    if (
      !route ||
      route.desired !== null ||
      route.applied !== null ||
      route.registrationId !== null ||
      actual.status !== 200 ||
      !actual.body ||
      typeof actual.body !== 'object' ||
      Array.isArray(actual.body) ||
      Object.hasOwn(actual.body, route.serverId)
    )
      throw new Error('LIVE_CLEANUP_REQUIRED');
    revalidateLiveApp(run.app);
  }
  private openInbox(run: LiveRun): SqliteLiveEventInbox {
    const app = createHash('sha256').update(`${run.app.device}:${run.app.inode}`).digest('hex');
    return new SqliteLiveEventInbox(join(this.cfg.privateDirectory, `inbox-${app}.sqlite`));
  }
  private async reconcileInbox(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run);
    if (!g.cli || !g.inbox) throw new Error('LIVE_INBOX_RECONCILIATION_REQUIRED');
    // Empty helper status cannot settle an ambiguous dispatched source edit.
    // Keep its intent/history locked for explicit supported reconciliation.
    const records = g.inbox.records(g.plannedGeneration);
    if (records.some((record) => record.stage !== 'acknowledged' && !record.reconciliation))
      throw new Error('LIVE_INBOX_RECONCILIATION_REQUIRED');
    const prior = records.find((record) => record.reconciliation)?.reconciliation;
    if (prior && records.some((record) => !record.reconciliation))
      throw new Error('LIVE_INBOX_RECONCILIATION_REQUIRED');
    const digest = await g.cli.reconcile(
      run,
      records
        .filter((record) => record.stage === 'acknowledged' && record.kind === 'steer')
        .flatMap((record) => (record.upstreamId ? [record.upstreamId] : [])),
    );
    this.owners.assert(run);
    g.inbox.reconcile(run, {
      disposition: 'completed',
      proofDigest: prior?.proofDigest ?? digest,
      generation: g.plannedGeneration,
    });
  }
  private async settleOwningProcess(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run),
      b = this.requireBindings();
    if (b.runtime.liveOwnerIds().includes(run.relayId)) {
      await b.runtime.inspectLiveQuiescence(g.session);
      return;
    }
    const native = this.capturedProcesses.get(g.policy.capture.captureId);
    if (!native || b.sessions.find(run.relayId)?.activeTurnId)
      throw new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    const session = b.sessions.find(run.relayId);
    if (!session || session.threadId !== run.rootThreadId)
      throw new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    await b.runtime.settleLiveWork(session, () => {
      this.owners.assert(run);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        native.waitForExit(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED')), 10000);
        }),
      ]);
      this.owners.assert(run);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async renewGeneration(run: LiveRun): Promise<{ targetIdentity: string }> {
    this.owners.assert(run);
    const previous = this.generations.get(run.relayId);
    if (
      !previous ||
      !previous.retired ||
      !this.revokedCaptures.has(previous.policy.capture.captureId) ||
      previous.plannedGeneration >= run.generation ||
      run.phase !== 'resume:prepare:intent'
    )
      throw new Error('LIVE_RUNTIME_RENEWAL_INVALID');
    const b = this.requireBindings();
    const mode = b.runtime.liveOwnerIds().includes(run.relayId) ? 'survivor' : 'replacement';
    let owningSession = currentOwningSession(previous.session, b.sessions.find(run.relayId));
    let capture: OwningRuntimeCapture | undefined;
    try {
      capture = await captureOwningRuntime({
        configuration: this.cfg,
        app: previous.app,
        session: owningSession,
        election: this.election,
        generation: run.generation,
        authenticationDirectory: b.authenticationDirectory,
        threadConfig: previous.observation.threadConfig,
        renewal: { previous: previous.policy.capture, mode },
      });
      this.owners.assert(run);
      this.captures.set(run.relayId, capture);
      await b.guard.liveMaintenance(run, async () => {
        if (mode === 'replacement') {
          this.pendingLaunches.set(capture!.captureId, capture!);
          this.renewalLaunches.set(run.relayId, {
            capture: capture!,
            fence: run,
            threadConfig: previous.observation.threadConfig,
          });
          owningSession = await b.runtime.restoreRenewedLiveOwner(
            owningSession,
            new Date().toISOString(),
            {
              modelConfig: previous.observation.threadConfig,
              skillsConfig: previous.observation.skillsConfig,
            },
            { owners: this.owners, fence: run, captureId: capture!.captureId },
          );
        } else {
          const native = this.capturedProcesses.get(previous.policy.capture.captureId);
          if (!native) throw new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
          this.capturedProcesses.set(capture!.captureId, native);
        }
        const observation = await b.runtime.inspectLiveAdmission(owningSession);
        if (
          !isDeepStrictEqual(
            observeOwningNative({
              configuration: observation.configuration,
              selection: observation.threadSelection,
              account: observation.account,
            }),
            observeOwningNative({
              configuration: previous.observation.configuration,
              selection: previous.observation.threadSelection,
              account: previous.observation.account,
            }),
          )
        )
          throw new Error('LIVE_RUNTIME_IDENTITY_CHANGED');
        const prepared = await prepareProductionPolicy({
          configuration: this.cfg,
          source: this.source,
          session: owningSession,
          observation,
          app: previous.app,
          directory: capture!.directory,
          authenticationDirectory: b.authenticationDirectory,
          capture: capture!,
          reconfigure: (modelConfig) =>
            b.runtime.reconfigureLiveOwner(owningSession, {
              modelConfig,
              skillsConfig: observation.skillsConfig,
            }),
          observe: () => b.runtime.inspectLiveAdmission(owningSession),
        });
        this.preparedOwners.set(run.relayId, prepared);
        this.originalObservations.set(run.relayId, observation);
      });
      const claim = await this.register(
        owningSession,
        previous.app,
        {
          relayId: run.relayId,
          appId: run.appId,
          targetId: run.targetId,
          operationId: run.operationId,
          authSessionHash: run.authSessionHash,
          deviceId: run.deviceId,
        },
        run,
      );
      this.generations.get(run.relayId)!.run = run;
      this.generations.get(run.relayId)!.replacementRestored = mode === 'replacement';
      return { targetIdentity: claim.targetIdentity };
    } catch (error) {
      if (capture) await this.revokeCapture(capture);
      throw error;
    } finally {
      this.renewalLaunches.delete(run.relayId);
      if (capture) this.pendingLaunches.delete(capture.captureId);
    }
  }
  private recordStartFailure(
    sessionId: string,
    stage: 'start-operation' | 'start-lifecycle' | 'resume-lifecycle',
    lifecycleStage: string,
    error: unknown,
  ): void {
    try {
      const phase = this.owners.read(sessionId)?.phase;
      const generation = this.generations.get(sessionId);
      writeFileSync(
        join(this.cfg.privateDirectory, `preparation-failure-${randomUUID()}.json`),
        JSON.stringify({
          schemaVersion: 1,
          stage,
          lifecycleStage,
          helper: generation?.helper.diagnostics(),
          devserver: generation?.devserver.diagnostics(),
          admission: error instanceof InstalledLiveAdmissionError ? error.diagnostic : undefined,
          phase: typeof phase === 'string' && /^[a-zA-Z:-]{1,96}$/.test(phase) ? phase : undefined,
          code:
            error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'UNCLASSIFIED',
          native:
            error instanceof CodexJsonRpcError
              ? { code: error.code, kind: error.kind, markers: error.liveDiagnosticMarkers }
              : undefined,
          context:
            error instanceof CodexLiveContextProbeError ? { markers: error.markers } : undefined,
          processStage:
            error instanceof Error &&
            'stage' in error &&
            typeof error.stage === 'string' &&
            /^[a-z][a-z0-9-]{0,63}$/.test(error.stage)
              ? error.stage
              : undefined,
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    } catch {
      /* Diagnostics never change admission, the original error, or cleanup. */
    }
  }
  private async register(
    session: RelaySessionSnapshot,
    app: App,
    request: LiveStartRequest,
    recovery?: LiveRun,
  ): Promise<LiveStartClaim> {
    const b = this.requireBindings();
    await b.settleAuxiliary();
    this.verifyHost();
    if (recovery) this.owners.assert(recovery);
    else this.owners.checkOrdinary(session.id, this.scopes(session));
    const current = await b.runtime.inspectLiveAdmission(session);
    const idle = await b.runtime.inspectLiveQuiescence(session);
    const capture = this.captures.get(session.id);
    if (!capture || this.revokedCaptures.has(capture.captureId))
      throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
    const expected = capture.generation;
    const directory = capture.directory;
    const prepared = this.preparedOwners.get(session.id);
    const observation = this.originalObservations.get(session.id);
    if (!prepared || !observation) throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
    assertProductionSourceObservation(prepared, current);
    await new InstalledLivePolicy(this.cfg.installation).verify(
      prepared.manifestPath,
      prepared.bootstrapPath,
      prepared.files,
    );
    const assignment = this.origins.assign(app.appRoot);
    const policy = prepared;
    let helper: IsolatedProjectProcess | undefined, devserver: IsolatedProjectProcess | undefined;
    let stage = 'original-config';
    try {
      let helperReceipt!: IsolatedProjectReceipt, devReceipt!: IsolatedProjectReceipt;
      const prepare = async () => {
        // Recheck actual original sources before changing its idle thread configuration.
        resolveLiveConfigFiles({
          configuration: observation.configuration,
          appRoot: app.appRoot,
          capturedProjectSources: capture.captured.directories,
          threadConfig: observation.threadConfig,
          approved: this.originalSurfaces(app, observation.threadConfig),
        });
        stage = 'original-permissions';
        owningPermissions({
          session,
          observation,
          appRoot: app.appRoot,
          protectedPaths: [
            this.cfg.privateDirectory,
            b.authenticationDirectory,
            this.cfg.nativeEnvironment.CODEX_HOME,
            this.cfg.caddy.controllerDirectory,
            `/tmp/codex-daemon-${process.getuid!()}`,
          ],
        });
        const common = {
          sessionId: session.id,
          generation: expected,
          appRoot: app.appRoot,
          privateDirectory: directory,
          native: this.cfg.native,
          bwrap: this.cfg.project.bwrap,
          node: this.cfg.project.node,
          worker: this.cfg.project.worker,
        };
        stage = 'helper-construction';
        helper = new IsolatedProjectProcess({
          ...common,
          role: 'helper',
          executable: this.cfg.project.helper,
          argv: ['live-server', `--port=${app.helperPort}`, '--target', app.appRoot],
          port: app.helperPort,
          environment: {
            PATH: '/usr/bin:/bin',
            HOME: '/tmp',
            TMPDIR: '/tmp',
            LANG: 'C.UTF-8',
            IMPECCABLE_LIVE_PUBLIC_BASE_URL: assignment.origin + '/__gestalt_live',
          },
          filesystem: capture.projectState.permissionProfile.file_system,
          protectedPaths: [
            this.cfg.privateDirectory,
            b.authenticationDirectory,
            this.cfg.nativeEnvironment.CODEX_HOME,
            this.cfg.caddy.controllerDirectory,
          ],
          launchInputs: [readLiveConfigFile(join(app.appRoot, '.impeccable/live/config.json'))],
        });
        stage = 'helper-start';
        helperReceipt = await helper.start();
        const caches = app.devserver.cacheDirectories.map((value) => {
          const path = join(app.appRoot, value);
          mkdirSync(path, { recursive: true, mode: 0o700 });
          if (realpathSync(path) !== path) throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
          return path;
        });
        const filesystem: IsolatedProjectSpecification['filesystem'] = {
          ...capture.projectState.permissionProfile.file_system,
          entries: [
            ...capture.projectState.permissionProfile.file_system.entries.map((entry) =>
              entry.access === 'write' && entry.path.type === 'path' && entry.path.path !== '/tmp'
                ? { ...entry, access: 'read' as const }
                : entry,
            ),
            ...caches.map((path) => ({
              path: { type: 'path' as const, path },
              access: 'write' as const,
            })),
            {
              path: { type: 'path' as const, path: join(app.appRoot, '.impeccable') },
              access: 'deny' as const,
            },
          ],
        };
        stage = 'devserver-construction';
        devserver = new IsolatedProjectProcess({
          ...common,
          role: 'devserver',
          executable: app.devserver.executable,
          argv: app.devserver.argv,
          environment: app.devserver.environment,
          port: app.devserver.port,
          launchInputs: app.devserver.launchInputs,
          filesystem,
          protectedPaths: [
            this.cfg.privateDirectory,
            b.authenticationDirectory,
            this.cfg.nativeEnvironment.CODEX_HOME,
            this.cfg.caddy.controllerDirectory,
            join(app.appRoot, '.impeccable'),
          ],
        });
        stage = 'devserver-start';
        devReceipt = await devserver.start();
        stage = 'model-output-layout';
        assertProductionSourceObservation(policy, await b.runtime.inspectLiveAdmission(session));
        prepareHelperOutputRoots(app.appRoot, capture.projectState);
      };
      if (recovery) await b.guard.liveMaintenance(recovery, prepare);
      else await b.guard.livePreparation(session, prepare);
      if (!recovery) b.guard.settle(session.id, idle.outstanding);
      const claim: LiveStartClaim = {
        ...request,
        provider: 'codex',
        admissionGeneration: expected,
        rootThreadId: session.threadId!,
        app: liveAppIdentity(app.appRoot),
        globallyExclusive: !livePolicyAppConfined(policy!.state, app.appRoot),
        // The bounded opaque HMAC binds the full process birth/namespace/spec.
        targetIdentity: devReceipt.signature,
        previewOrigin: assignment.origin,
      };
      this.generations.set(session.id, {
        app,
        session,
        observation,
        plannedGeneration: expected,
        policy: policy!,
        helper: helper!,
        helperReceipt,
        devserver: devserver!,
        devReceipt,
        claim,
        resumed: true,
        injected: false,
        retired: false,
      });
      return claim;
    } catch (error) {
      // Bounded private diagnostics. Never write argv, response bodies, paths,
      // source configuration, prompts or environment values into this record.
      try {
        writeFileSync(
          join(this.cfg.privateDirectory, `preparation-failure-${randomUUID()}.json`),
          JSON.stringify({
            schemaVersion: 1,
            stage,
            processStage:
              error instanceof Error &&
              'stage' in error &&
              typeof error.stage === 'string' &&
              /^[a-z][a-z0-9-]{0,63}$/.test(error.stage)
                ? error.stage
                : undefined,
            code:
              error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
                ? error.message
                : 'UNCLASSIFIED',
            effectiveConfig:
              error instanceof Error && 'liveConfigDiagnostics' in error
                ? error.liveConfigDiagnostics
                : undefined,
            launchInventory:
              error instanceof Error && 'liveLaunchInventory' in error
                ? error.liveLaunchInventory
                : undefined,
            helper: helper?.diagnostics(),
            devserver: devserver?.diagnostics(),
          }) + '\n',
          { mode: 0o600, flag: 'wx' },
        );
      } catch {
        /* Diagnostic IO cannot waive failure or prevent cleanup. */
      }
      // Independent resources must all be attempted; failed teardown retains the
      // original writer exclusion and authority key for explicit reconciliation.
      let cleanupFailed = false;
      try {
        await this.revokeCapture(capture);
      } catch {
        cleanupFailed = true;
      }
      const closed = await Promise.allSettled([devserver?.stop(), helper?.stop()]);
      cleanupFailed ||= closed.some((result) => result.status === 'rejected');
      if (!cleanupFailed) {
        try {
          const restore = () =>
            b.runtime.reconfigureLiveOwner(session, {
              modelConfig: observation.threadConfig,
              skillsConfig: observation.skillsConfig,
            });
          if (recovery) await b.guard.liveMaintenance(recovery, restore);
          else await b.guard.livePreparation(session, restore);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        this.failedPreparations.add(session.id);
        throw new Error('LIVE_CLEANUP_REQUIRED');
      }
      throw error;
    }
  }
  private generation(run: LiveRun): Generation {
    this.owners.assert(run);
    const g = this.generations.get(run.relayId);
    if (
      !g ||
      g.plannedGeneration !== run.generation ||
      g.claim.rootThreadId !== run.rootThreadId ||
      g.claim.targetIdentity !== run.targetIdentity
    )
      throw new Error('LIVE_GENERATION_STALE');
    g.run = run;
    return g;
  }
  /** Recovery may retire an earlier generation's exact resources, but cannot
   * use them for admission, model turns, polling, authorization or exposure. */
  private cleanupGeneration(run: LiveRun): Generation {
    this.owners.assert(run);
    const g = this.generations.get(run.relayId);
    if (
      !g ||
      !g.run ||
      g.run.liveId !== run.liveId ||
      g.run.controllerEpoch !== run.controllerEpoch ||
      g.plannedGeneration > run.generation ||
      g.claim.rootThreadId !== run.rootThreadId ||
      g.claim.targetIdentity !== run.targetIdentity ||
      g.claim.app.device !== run.app.device ||
      g.claim.app.inode !== run.app.inode ||
      (g.plannedGeneration !== run.generation &&
        !['stopping', 'recoveryRequired'].includes(run.state))
    )
      throw new Error('LIVE_GENERATION_STALE');
    return g;
  }
  private async verifyProjectResources(g: Generation): Promise<void> {
    const files = new ConnectionFileVerification();
    const cancellation = new AbortController();
    try {
      const current = await Promise.all([
        g.helper.verifyForConnection(g.helperReceipt, cancellation.signal, files),
        g.devserver.verifyForConnection(g.devReceipt, cancellation.signal, files),
      ]);
      for (const assertCurrent of current) assertCurrent();
    } catch (error) {
      cancellation.abort();
      throw error;
    } finally {
      files.close();
    }
  }
  private async verifyGeneration(run: LiveRun): Promise<void> {
    const g = this.generation(run);
    this.verifyHost();
    revalidateLiveApp(run.app);
    if (
      !this.preview!.authentication.authorized(
        run.authSessionHash,
        run.deviceId,
        this.preview!.now().toISOString(),
      )
    )
      throw new Error('LIVE_AUTH_UNAVAILABLE');
    const digests = await new InstalledLivePolicy(this.cfg.installation).verify(
      g.policy.manifestPath,
      g.policy.bootstrapPath,
      g.policy.files,
    );
    if (!isDeepStrictEqual(digests, g.policy.digests)) throw new Error('LIVE_CONFIG_CHANGED');
    await this.verifyProjectResources(g);
    this.owners.assert(run);
    if (g.resumed) await this.verifyLiveRuntime(run);
  }
  verifyLiveRuntime = async (fence: LiveFence): Promise<void> => {
    const run = this.owners.assert(fence),
      g = this.generation(run),
      b = this.requireBindings();
    try {
      this.verifyHost();
      const session = b.sessions.find(run.relayId);
      if (
        !session ||
        session.provider !== 'codex' ||
        session.threadId !== run.rootThreadId ||
        !g.resumed
      )
        throw new Error('LIVE_RUNTIME_UNAVAILABLE');
      const observed = await b.runtime.inspectLiveAdmission(session);
      assertProductionSourceObservation(g.policy, observed);
      for (const field of [
        'threadId',
        'model',
        'modelProvider',
        'cwd',
        'reasoningEffort',
        'approvalPolicy',
        'activePermissionProfile',
        'runtimeWorkspaceRoots',
      ])
        if (!isDeepStrictEqual(observed.threadSelection?.[field], g.policy.selection[field]))
          throw new Error('LIVE_RUNTIME_IDENTITY_CHANGED');
      if (!isDeepStrictEqual(observed.threadConfig, g.policy.modelConfig))
        throw new Error('LIVE_CONFIG_CHANGED');
      assertAdmittedLiveMcp(observed.mcp);
      const digests = await new InstalledLivePolicy(this.cfg.installation).verify(
        g.policy.manifestPath,
        g.policy.bootstrapPath,
        g.policy.files,
      );
      if (!isDeepStrictEqual(digests, g.policy.digests)) throw new Error('LIVE_CONFIG_CHANGED');
      await this.verifyProjectResources(g);
      this.owners.assert(fence);
    } catch (error) {
      // Stop may revoke admission while its old poll is still verifying. Stop
      // owns that exact generation's drain; never turn its expected refusal
      // into a second recovery transition or grant the old poll authority.
      const current = this.owners.current(run.liveId);
      if (
        current?.controllerEpoch === run.controllerEpoch &&
        current.generation === run.generation &&
        ['stopping', 'idle'].includes(current.state)
      )
        throw error;
      // Flags are private Native RPC state: Manager cannot observe their change
      // itself. Revoke the exact old admission before retaining recovery ownership.
      let revoked = false;
      try {
        await this.revokeCapture(g.policy.capture);
        revoked = true;
      } catch {
        /* keep the durable lock */
      }
      try {
        await this.connections!.revoke({ liveId: run.liveId, throughGeneration: run.generation });
      } catch {
        /* cleanup remains required */
      }
      try {
        const current = this.owners.assert(fence);
        const recovery = this.owners.mutate(current, {
          event: 'recover',
          code: 'LIVE_ADMISSION_CHANGED',
        });
        await b.runtime.abortLiveOwner(g.session, { owners: this.owners, fence: recovery });
        g.resumed = false;
      } catch {
        this.failedPreparations.add(run.relayId);
      }
      if (!revoked) this.failedPreparations.add(run.relayId);
      throw error;
    }
  };
  private async prepareOwner(run: LiveRun): Promise<void> {
    const g = this.generation(run),
      b = this.requireBindings();
    g.cli = new IsolatedLiveHelper({
      owners: this.owners,
      run,
      process: g.helper,
      receipt: g.helperReceipt,
      privateDirectory: g.policy.directory,
      port: g.app.helperPort,
      publicBaseUrl: run.previewOrigin + '/__gestalt_live',
    });
    const injected = (await g.cli.inject()) as { ok?: boolean };
    if (injected?.ok !== true) throw new Error('LIVE_HELPER_NOT_READY');
    g.injected = true;
    g.injectionArtifacts = captureLiveInjection(g.app.appRoot);
    writeFileSync(
      join(g.policy.directory, 'injection-artifacts.json'),
      JSON.stringify(g.injectionArtifacts) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await g.cli.status();
    assertProductionSourceObservation(g.policy, await b.runtime.inspectLiveAdmission(g.session));
    prepareHelperOutputRoots(g.app.appRoot, g.policy.capture.projectState);
    await b.guard.liveMaintenance(run, async () => {
      g.resumed = true;
      const admission = new InstalledLivePolicy(this.cfg.installation);
      const prior = admission.contextLaunchIds(g.policy.manifestPath);
      await b.runtime.probeLiveContext(g.session, g.policy.probePath);
      admission.assertCompletedContextLaunch(
        g.policy.manifestPath,
        prior,
        g.policy.digests.policyDigest,
      );
    });
  }
  private async authorize(run: LiveRun): Promise<void> {
    await this.verifyGeneration(run);
    await this.generation(run).cli!.status();
  }
  private async expose(run: LiveRun): Promise<void> {
    const g = this.generation(run);
    const assignment = this.origins.assign(g.app.appRoot);
    const instance = {
      relayId: run.relayId,
      appId: run.appId,
      liveId: run.liveId,
      generation: run.generation,
      previewOrigin: run.previewOrigin,
    };
    g.registrationId = this.targets.register({
      appRoot: g.app.appRoot,
      appPort: g.app.devserver.port,
      helperPort: g.app.helperPort,
      gatewayPort: g.app.gatewayPort,
    });
    g.gateway = await createPreviewGateway({
      deps: this.preview!,
      instance,
      assignment,
      targets: this.targets,
      registrationId: g.registrationId,
      connections: this.connections!,
      upstreams: isolatedPreviewUpstreams({
        instance,
        appRoot: g.app.appRoot,
        helper: { process: g.helper, receipt: g.helperReceipt },
        devserver: { process: g.devserver, receipt: g.devReceipt },
      }),
    });
    await g.gateway.listen();
    const boundary = new ManagedCaddyAdminBoundary({
      codexExecutable: this.cfg.native.path,
      nativeNoProc: true,
      projectDirectory: g.app.appRoot,
      controllerDirectory: this.cfg.caddy.controllerDirectory,
      socketPath: this.cfg.caddy.socketPath,
      credentialPath: this.cfg.caddy.credentialPath,
      effectiveSandboxState: () => g.policy.state,
      sandboxEnvironment: {
        PATH: '/usr/bin:/bin',
        HOME: g.policy.directory,
        CODEX_HOME: join(g.policy.directory, 'native-worker-home'),
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
      },
    });
    const routes = new CaddyRoutes(
      new UnixCaddyAdmin(this.cfg.caddy.socketPath),
      this.origins,
      this.targets,
    );
    const credential = readFileSync(this.cfg.caddy.credentialPath, 'utf8').trim();
    await new CaddyRouteBroker(credential, routes, boundary).execute(credential, {
      action: 'activate',
      appRoot: g.app.appRoot,
      registrationId: g.registrationId,
    });
  }
  private async revokeCapture(capture: OwningRuntimeCapture): Promise<void> {
    if (this.revokedCaptures.has(capture.captureId)) return;
    await new InstalledLivePolicy(this.cfg.installation).revokeRuntime(
      capture.manifestPath,
      capture.captureId,
    );
    this.revokedCaptures.add(capture.captureId);
  }
  /** Poll failure/lease exit must revoke Native admission too, before drain. */
  revokePollGeneration = async (scope: PreviewRevocationScope): Promise<void> => {
    if (!('liveId' in scope) || !('throughGeneration' in scope))
      throw new Error('LIVE_GENERATION_STALE');
    const run = this.owners.current(scope.liveId);
    if (
      !run ||
      scope.throughGeneration !== run.generation ||
      !['stopping', 'recoveryRequired'].includes(run.state)
    )
      throw new Error('LIVE_GENERATION_STALE');
    await this.revoke(run);
  };
  private async revoke(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run);
    const results = await Promise.allSettled([
      this.revokeCapture(g.policy.capture),
      this.connections!.revoke({ liveId: run.liveId, throughGeneration: run.generation }),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('LIVE_CLEANUP_REQUIRED');
  }
  private async remove(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run);
    await g.gateway?.close();
    g.gateway = undefined;
    await new CaddyRoutes(
      new UnixCaddyAdmin(this.cfg.caddy.socketPath),
      this.origins,
      this.targets,
    ).remove(g.app.appRoot);
    if (g.registrationId) this.targets.unregister(g.registrationId);
    g.registrationId = undefined;
  }
  private async cleanup(run: LiveRun, preserveOwner = false): Promise<void> {
    const g = this.cleanupGeneration(run);
    let failed = false;
    try {
      await this.revoke(run);
    } catch {
      failed = true;
    }
    if (g.loop) {
      try {
        await g.loop.drain(run);
      } catch {
        failed = true;
      }
    }
    if (g.resumed && !preserveOwner) {
      try {
        await this.requireBindings().runtime.abortLiveOwner(g.session, {
          owners: this.owners,
          fence: run,
        });
        g.resumed = false;
      } catch {
        failed = true;
      }
    }
    if (g.injected) {
      try {
        await g.cli!.removeInjection(run);
        verifyLiveInjectionRemoved(g.app.appRoot, g.injectionArtifacts ?? []);
        g.injected = false;
      } catch {
        failed = true;
      }
    }
    let processesClosed = true;
    for (const process of [g.devserver, g.helper]) {
      try {
        await process.stop();
      } catch {
        failed = true;
        processesClosed = false;
      }
    }
    if ((!g.resumed || preserveOwner) && processesClosed) {
      try {
        g.cli?.forgetExitedServerRecord();
      } catch {
        failed = true;
      }
      g.retired = true;
    }
    g.inbox?.close();
    if (failed || g.injected || !g.retired) throw new Error('LIVE_CLEANUP_REQUIRED');
  }
  private async restoreOriginal(run: LiveRun): Promise<void> {
    const g = this.cleanupGeneration(run),
      b = this.requireBindings();
    if (!g.retired || g.injected) throw new Error('LIVE_CLEANUP_REQUIRED');
    await b.guard.liveMaintenance(run, async () => {
      const configuration = {
        modelConfig: g.observation.threadConfig,
        skillsConfig: g.observation.skillsConfig,
      };
      if (b.runtime.liveOwnerIds().includes(g.session.id)) {
        await b.runtime.reconfigureLiveOwner(g.session, configuration);
        const current = await b.runtime.inspectLiveAdmission(g.session);
        assertOriginalLiveMcp(current.mcp, g.app.owningPolicy?.originalLaunchSources?.[0]);
        if (
          !isDeepStrictEqual(current.launch, g.observation.launch) ||
          !isDeepStrictEqual(current.configuration, g.observation.configuration) ||
          !isDeepStrictEqual(current.threadConfig, g.observation.threadConfig) ||
          !isDeepStrictEqual(current.skillsConfig, g.observation.skillsConfig) ||
          !isDeepStrictEqual(
            observeOwningNative({
              configuration: current.configuration,
              selection: current.threadSelection,
              account: current.account,
            }),
            observeOwningNative({
              configuration: g.observation.configuration,
              selection: g.observation.threadSelection,
              account: g.observation.account,
            }),
          )
        )
          throw new Error('LIVE_ORIGINAL_CONFIGURATION_UNVERIFIED');
        g.resumed = false;
      } else {
        const restored = await b.runtime.restoreLiveOwner(
          g.session,
          new Date().toISOString(),
          configuration,
        );
        b.saveSession(restored);
      }
    });
  }
  private async unregister(claim: LiveStartClaim): Promise<void> {
    const g = this.generations.get(claim.relayId);
    if (!g || g.claim !== claim) return;
    if (g.run && !g.retired) throw new Error('LIVE_CLEANUP_REQUIRED');
    if (!g.run) {
      let failed = false;
      try {
        await this.revokeCapture(g.policy.capture);
      } catch {
        failed = true;
      }
      const stopped = await Promise.allSettled([g.devserver.stop(), g.helper.stop()]);
      failed ||= stopped.some((result) => result.status === 'rejected');
      try {
        const b = this.requireBindings();
        b.guard.reacquirePreparation(g.session);
        await b.guard.livePreparation(g.session, () =>
          b.runtime.reconfigureLiveOwner(g.session, {
            modelConfig: g.observation.threadConfig,
            skillsConfig: g.observation.skillsConfig,
          }),
        );
        g.resumed = false;
      } catch {
        failed = true;
      }
      if (failed) {
        this.failedPreparations.add(g.session.id);
        throw new Error('LIVE_CLEANUP_REQUIRED');
      }
      g.retired = true;
    }
    this.generations.delete(claim.relayId);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const current = this.serial.catch(() => {}).then(work);
    this.serial = current;
    return current;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.serial
      .catch(() => {})
      .then(async () => {
        let failed = false;
        for (const g of this.generations.values()) {
          try {
            if (g.run) {
              let run = this.owners.current(g.run.liveId);
              if (
                !run ||
                run.controllerEpoch !== g.run.controllerEpoch ||
                run.rootThreadId !== g.session.threadId
              )
                throw new Error('LIVE_GENERATION_STALE');
              if (run.state === 'idle' && run.controlsRestored && g.retired) {
                await this.verifyClean(run);
                continue;
              }
              if (run.generation !== g.plannedGeneration) {
                // Recovery denies admission before its asynchronous revocation
                // completes. Join that drain and attempt signed revocation before
                // terminating the original owner. Never reuse old CLI authority.
                await g.loop?.waitForRecoveryDrain(run);
                try {
                  await this.revokeCapture(g.policy.capture);
                } catch {
                  failed = true;
                }
                try {
                  await this.connections?.revoke({
                    liveId: run.liveId,
                    throughGeneration: run.generation,
                  });
                } catch {
                  failed = true;
                }
                if (g.resumed) {
                  try {
                    await this.requireBindings().runtime.abortLiveOwner(g.session, {
                      owners: this.owners,
                      fence: run,
                    });
                    g.resumed = false;
                  } catch {
                    failed = true;
                  }
                }
                const retired = await Promise.allSettled([
                  g.devserver.stop(),
                  g.helper.stop(),
                  g.gateway?.close(),
                ]);
                if (retired.some((result) => result.status === 'rejected'))
                  throw new Error('LIVE_CLEANUP_REQUIRED');
                if (!g.resumed) {
                  g.retired = true;
                }
                // Source/route reconciliation remains required under its durable lock.
                failed = true;
                continue;
              }
              if (['starting', 'active', 'error', 'recoveryRequired'].includes(run.state))
                run = this.owners.mutate(run, { event: 'stop' });
              g.run = run;
              // Durable stopping fences dispatch before physical stream revocation.
              try {
                await this.revoke(run);
              } catch {
                failed = true;
              }
              // Route and resource cleanup are independent; neither failure hides
              // an attempted owning-runtime/namespace teardown.
              const results = await Promise.allSettled([this.remove(run), this.cleanup(run)]);
              if (results.some((result) => result.status === 'rejected')) failed = true;
              const current = this.owners.current(run.liveId);
              if (current?.state === 'stopping')
                this.owners.mutate(current, {
                  event: 'recover',
                  code: 'LIVE_SHUTDOWN_RECONCILIATION_REQUIRED',
                });
            } else {
              const results = await Promise.allSettled([g.devserver.stop(), g.helper.stop()]);
              if (results.some((result) => result.status === 'rejected'))
                throw new Error('LIVE_CLEANUP_REQUIRED');
              g.retired = true;
            }
          } catch {
            failed = true;
          }
        }
        for (const capture of this.captures.values()) {
          try {
            await this.revokeCapture(capture);
          } catch {
            failed = true;
          }
        }
        const exited = await Promise.allSettled(
          [...this.capturedProcesses.values()].map(async (native) => {
            native.close();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                native.waitForExit(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('LIVE_RUNTIME_LIFETIME_UNVERIFIED')),
                    10000,
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }),
        );
        if (exited.some((result) => result.status === 'rejected')) failed = true;
        // Every original handle is attempted before retaining a failed cleanup
        // lock. Election release requires positive closure of all owned resources.
        if (
          this.failedPreparations.size ||
          [...this.generations.values()].some((g) => !g.retired) ||
          exited.some((result) => result.status === 'rejected')
        )
          throw new Error('LIVE_CLEANUP_REQUIRED');
        if (
          [...this.captures.values()].some(
            (capture) => !this.revokedCaptures.has(capture.captureId),
          )
        )
          throw new Error('LIVE_CLEANUP_REQUIRED');
        this.origins.close();
        await this.releaseElection();
        if (failed || this.failedPreparations.size) throw new Error('LIVE_CLEANUP_REQUIRED');
      });
    return this.closing;
  }
}

export async function createProductionLiveController(
  path: string,
): Promise<ProductionLiveController> {
  const { configuration, source } = readProductionLiveConfiguration(path);
  new InstalledLivePolicy(configuration.installation).validateInstallation();
  const elected = await electLiveController({
    privateDirectory: configuration.privateDirectory,
    controllerId: randomUUID(),
    initialize: true,
  });
  try {
    return new ProductionLiveController(
      elected.ownership,
      configuration,
      source,
      elected.close,
      elected.election,
    );
  } catch (error) {
    await elected.close();
    throw error;
  }
}
