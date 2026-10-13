/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { SessionRepository } from '../../features/sessions/application/ports.js';
import type { LiveControls } from '../../features/live-design/application/controls.js';
import type {
  LiveRun,
  LiveStartClaim,
  LiveFence,
} from '../../features/live-design/application/ownership.js';
import type { PreviewGrantDependencies } from '../../features/live-design/application/ports.js';
import { startLive, type LiveStartRequest } from '../../features/live-design/start/use-case.js';
import type { LivePollLoop } from '../../features/live-design/application/poll-loop.js';
import type {
  CanonicalLivePoll,
  LiveEventInbox,
} from '../../features/live-design/application/poll-events.js';
import { CodexSessionRuntime, type AppServerLaunchInput } from '../codex/session-runtime.js';
import { launchCodexAppServer } from '../codex/codex-process-launcher.js';
import { electLiveController } from './elected-controller.js';
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
import { prepareProductionPolicy, type PreparedProductionPolicy } from './production-policy.js';
import {
  readLiveConfigFile,
  resolveLiveConfigFiles,
  type LiveConfigFile,
} from './effective-config.js';
import { livePolicyAppConfined, owningPermissions } from './owning-permissions.js';
import { InstalledLivePolicy, measureInstalledLiveTree } from './installed-policy.js';
import {
  IsolatedProjectProcess,
  type IsolatedProjectReceipt,
  type IsolatedProjectSpecification,
} from './isolated-project-process.js';
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
  retired: boolean;
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
  private readonly origins: CaddyRouteStore;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    readonly owners: SqliteLiveOwnership,
    private readonly cfg: ProductionLiveConfiguration,
    private readonly source: LiveConfigFile,
    private readonly releaseElection: () => Promise<void>,
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
    this.pollFactory = create;
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
  }
  launchNative(input: AppServerLaunchInput) {
    this.verifyHost();
    const environment: Record<string, string> = { ...this.cfg.nativeEnvironment };
    for (const name of this.cfg.providerCredentialEnvironment) {
      // Forward only explicit host-authorized standard bindings; never discover
      // credentials or read unrelated credential/configuration files.
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    return launchCodexAppServer(input, {
      executable: this.cfg.native.path,
      sha256: this.cfg.native.sha256,
      environment,
    });
  }
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
  /** Called after actual native start/resume, before exposing ordinary writer readiness. */
  async observeOwnerStarted(session: RelaySessionSnapshot): Promise<void> {
    if (this.generations.has(session.id) || this.preflight.has(session.id)) return;
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
      ];
      resolveLiveConfigFiles({
        configuration: observation.configuration,
        threadConfig: observation.threadConfig,
        approved: { mcpServers: {}, plugins: {} },
      });
      const mcp = observation.mcp as { data?: unknown[]; nextCursor?: unknown };
      if (!Array.isArray(mcp.data) || mcp.data.length || mcp.nextCursor)
        throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
      const { state } = owningPermissions({
        session,
        observation,
        appRoot: app.appRoot,
        protectedPaths,
      });
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
    } catch {
      // Ordinary workflows remain usable under an unknown/global reservation.
      // Start repeats the full admission checks and cannot acquire authority here.
      this.scopesBySession.delete(session.id);
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
      try {
        const run = await startLive(
          {
            owners: this.owners,
            controls: this.controls!,
            revalidateApp: revalidateLiveApp,
            admission: {
              register: () => this.register(session, app, request),
              unregister: (claim) => this.unregister(claim),
              busy: async () => bindings.runtime.liveOwnerIds().includes(session.id),
              verify: (candidate) => this.verifyGeneration(candidate),
            },
            resources: {
              quiesce: async (candidate) => {
                const g = this.generation(candidate);
                if (bindings.runtime.liveOwnerIds().includes(g.session.id))
                  throw new Error('LIVE_SESSION_BUSY');
              },
              restore: (candidate) => this.restoreOriginal(candidate),
              prepare: (candidate) => this.prepareOwner(candidate),
              cleanup: (candidate) => this.cleanup(candidate),
              authorize: (candidate) => this.authorize(candidate),
              revoke: (candidate) => this.revoke(candidate),
              expose: (candidate) => this.expose(candidate),
              remove: (candidate) => this.remove(candidate),
            },
          },
          request,
        );
        const generation = this.generation(run);
        generation.run = run;
        generation.inbox = new SqliteLiveEventInbox(
          join(generation.policy.directory, 'inbox.sqlite'),
        );
        generation.loop = this.pollFactory!(generation.cli!, generation.inbox);
        // The sole durable poll owner is the production composition's existing dispatcher.
        void generation.loop.run(run).catch(() => {});
        return run;
      } finally {
        this.preflight.delete(session.id);
      }
    });
  }
  private async register(
    session: RelaySessionSnapshot,
    app: App,
    request: LiveStartRequest,
  ): Promise<LiveStartClaim> {
    const b = this.requireBindings();
    await b.settleAuxiliary();
    this.verifyHost();
    this.owners.checkOrdinary(session.id, this.scopes(session));
    const observation = await b.runtime.inspectLiveAdmission(session);
    const idle = await b.runtime.inspectLiveQuiescence(session);
    const expected = this.owners.preparationGeneration();
    const directory = join(this.cfg.privateDirectory, `generation-${randomUUID()}`);
    const assignment = this.origins.assign(app.appRoot);
    let policy: PreparedProductionPolicy | undefined,
      helper: IsolatedProjectProcess | undefined,
      devserver: IsolatedProjectProcess | undefined;
    let ownerReleased = false;
    let ownerReleaseAttempted = false;
    let stage = 'original-config';
    try {
      let helperReceipt!: IsolatedProjectReceipt, devReceipt!: IsolatedProjectReceipt;
      await b.guard.livePreparation(session, async () => {
        // Actual source/policy checks run before closing an idle owner or making keys.
        resolveLiveConfigFiles({
          configuration: observation.configuration,
          threadConfig: observation.threadConfig,
          approved: { mcpServers: {}, plugins: {} },
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
        ownerReleaseAttempted = true;
        stage = 'owning-unload';
        await b.runtime.releaseLivePreparation(session);
        ownerReleased = true;
        stage = 'policy-preparation';
        policy = await prepareProductionPolicy({
          configuration: this.cfg,
          source: this.source,
          session,
          observation,
          app,
          directory,
          authenticationDirectory: b.authenticationDirectory,
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
          filesystem: policy.baselineState.permissionProfile.file_system,
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
          ...policy.baselineState.permissionProfile.file_system,
          entries: [
            ...policy.baselineState.permissionProfile.file_system.entries.map((entry) =>
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
      });
      b.guard.settle(session.id, idle.outstanding);
      const claim: LiveStartClaim = {
        ...request,
        provider: 'codex',
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
        resumed: false,
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
            code:
              error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
                ? error.message
                : 'UNCLASSIFIED',
            ownerReleased,
            ownerReleaseAttempted,
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
      const closed = await Promise.allSettled([devserver?.stop(), helper?.stop()]);
      let cleanupFailed = closed.some((result) => result.status === 'rejected');
      if (!cleanupFailed) {
        try {
          // The key may exist even when policy preparation never returned.
          const keyPath = join(directory, 'policy-key');
          if (existsSync(keyPath)) unlinkSync(keyPath);
          if (ownerReleased) {
            await b.guard.livePreparation(session, async () => {
              const restored = await b.runtime.restoreLiveOwner(session, new Date().toISOString(), {
                modelConfig: observation.threadConfig,
                skillsConfig: observation.skillsConfig,
              });
              b.saveSession(restored);
            });
          } else if (ownerReleaseAttempted) {
            // An unsuccessful unload is not positive process-tree close proof.
            cleanupFailed = true;
          }
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
    g.helper.verify(g.helperReceipt);
    g.devserver.verify(g.devReceipt);
    if (g.resumed) await this.verifyLiveRuntime(run);
  }
  verifyLiveRuntime = async (fence: LiveFence): Promise<void> => {
    const run = this.owners.assert(fence),
      g = this.generation(run),
      b = this.requireBindings();
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
    const mcp = observed.mcp as {
      data?: { name: string; runtimeStatus?: string; toolsError?: unknown; httpOrigin?: unknown }[];
      nextCursor?: unknown;
    };
    if (
      !Array.isArray(mcp.data) ||
      mcp.data.length !== 2 ||
      mcp.nextCursor ||
      !isDeepStrictEqual(mcp.data.map((server) => server.name).sort(), [
        'context-mode',
        'gestalt-org-plan',
      ]) ||
      mcp.data.some(
        (server) => server.runtimeStatus !== 'connected' || server.toolsError || server.httpOrigin,
      )
    )
      throw new Error('LIVE_MCP_UNAVAILABLE');
    const digests = await new InstalledLivePolicy(this.cfg.installation).verify(
      g.policy.manifestPath,
      g.policy.bootstrapPath,
      g.policy.files,
    );
    if (!isDeepStrictEqual(digests, g.policy.digests)) throw new Error('LIVE_CONFIG_CHANGED');
    g.helper.verify(g.helperReceipt);
    g.devserver.verify(g.devReceipt);
    this.owners.assert(fence);
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
    await g.cli.status();
    await b.guard.liveMaintenance(run, async () => {
      const session = await b.runtime.restoreLiveOwner(g.session, new Date().toISOString(), {
        modelConfig: g.policy.modelConfig,
        skillsConfig: g.observation.skillsConfig,
      });
      b.saveSession(session);
      g.resumed = true;
      await b.runtime.probeLiveContext(session, g.policy.probePath);
    });
  }
  private async authorize(run: LiveRun): Promise<void> {
    await this.verifyGeneration(run);
    await this.generation(run).cli!.status();
  }
  private async expose(run: LiveRun): Promise<void> {
    const g = this.generation(run);
    const assignment = this.origins.assign(g.app.appRoot);
    g.registrationId = this.targets.register({
      appRoot: g.app.appRoot,
      appPort: g.app.devserver.port,
      helperPort: g.app.helperPort,
      gatewayPort: g.app.gatewayPort,
    });
    g.gateway = await createPreviewGateway({
      deps: this.preview!,
      instance: run,
      assignment,
      targets: this.targets,
      registrationId: g.registrationId,
      connections: this.connections!,
      upstreams: isolatedPreviewUpstreams({
        instance: run,
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
  private async revoke(run: LiveRun): Promise<void> {
    this.generation(run);
    await this.connections!.revoke({ liveId: run.liveId, throughGeneration: run.generation });
  }
  private async remove(run: LiveRun): Promise<void> {
    const g = this.generation(run);
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
  private async cleanup(run: LiveRun): Promise<void> {
    const g = this.generation(run);
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
    if (g.injected) {
      try {
        const removed = (await g.cli!.inject(true)) as { ok?: boolean };
        if (removed?.ok !== true) throw new Error();
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
    if (!g.resumed && processesClosed) {
      try {
        g.cli?.forgetExitedServerRecord();
      } catch {
        failed = true;
      }
      if (existsSync(g.policy.keyPath)) unlinkSync(g.policy.keyPath);
      g.retired = true;
    }
    g.inbox?.close();
    if (failed || g.injected || !g.retired) throw new Error('LIVE_CLEANUP_REQUIRED');
  }
  private async restoreOriginal(run: LiveRun): Promise<void> {
    const g = this.generation(run),
      b = this.requireBindings();
    if (!g.retired || g.resumed || g.injected) throw new Error('LIVE_CLEANUP_REQUIRED');
    await b.guard.liveMaintenance(run, async () => {
      const restored = await b.runtime.restoreLiveOwner(g.session, new Date().toISOString(), {
        modelConfig: g.observation.threadConfig,
        skillsConfig: g.observation.skillsConfig,
      });
      b.saveSession(restored);
    });
  }
  private async unregister(claim: LiveStartClaim): Promise<void> {
    const g = this.generations.get(claim.relayId);
    if (!g || g.claim !== claim) return;
    if (g.run && !g.retired) throw new Error('LIVE_CLEANUP_REQUIRED');
    if (!g.run) {
      await g.devserver.stop();
      await g.helper.stop();
      if (existsSync(g.policy.keyPath)) unlinkSync(g.policy.keyPath);
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
              if (run.generation !== g.plannedGeneration) {
                // Recovery has already revoked the old generation. Never reuse
                // its CLI authority, but still retire these exact owned lifetimes.
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
                  if (existsSync(g.policy.keyPath)) unlinkSync(g.policy.keyPath);
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
              if (existsSync(g.policy.keyPath)) unlinkSync(g.policy.keyPath);
              g.retired = true;
            }
          } catch {
            failed = true;
          }
        }
        // Do not relinquish the elected process while any broader worker lacks
        // positive close evidence. Durable recovery locks survive successful close.
        if (this.failedPreparations.size || [...this.generations.values()].some((g) => !g.retired))
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
    return new ProductionLiveController(elected.ownership, configuration, source, elected.close);
  } catch (error) {
    await elected.close();
    throw error;
  }
}
