/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyInstance } from 'fastify';

import { registerGetHealth, type HealthReader } from './features/health/get-health/endpoint.js';
import { registerGetBootstrap } from './features/catalog/get-bootstrap/endpoint.js';
import { registerAuthRoutes } from './features/auth/register-routes.js';
import { registerGitRoutes } from './features/git/register-routes.js';
import type { BootstrapDependencies } from './features/catalog/get-bootstrap/use-case.js';
import type {
  ModelCatalog,
  ProfileCatalog,
  WorkspaceCatalog,
} from './features/catalog/application/ports.js';
import { registerPlanRoutes } from './features/plans/register-routes.js';
import type { RecentThread } from './features/sessions/list-recent-threads/endpoint.js';
import { registerSessionRoutes } from './features/sessions/register-routes.js';
import type { InteractionReplyResult } from './features/sessions/respond-interaction/endpoint.js';
import type { SupervisedPlan } from './features/plans/domain/supervised-plan.js';
import type { WorkspacePlanCatalogSource } from './features/plans/application/ports.js';
import type { RelaySessionSnapshot } from './features/sessions/model/relay-session.js';
import type { AgentActivitySnapshot } from './features/agent-activity/model.js';
import type { SessionEvent } from '../shared/contracts/session-event.js';
import type {
  SafeInteractionOutcome,
  SafeInteractionSnapshot,
} from '../shared/contracts/chat-snapshot.js';
import { registerProblemHandler } from './platform/http/problem-handler.js';
import { registerAuthorizationBoundary } from './platform/http/authorization-boundary.js';
import type { StartSessionSettings } from './features/sessions/application/start-settings.js';
import type { RestoreSessionResult } from './platform/codex/session-runtime.js';
import type { WriterAcquisition } from './features/sessions/application/writer-acquisition.js';
import type { SkillCatalog, SkillProfileStore } from './features/skills/application/ports.js';
import type { SkillProfile } from './features/skills/model/skill-profile.js';
import type { GitSummary, GitWorkspaceResolver } from './features/git/application/ports.js';
import { registerSkillRoutes } from './features/skills/register-routes.js';
import { registerOrgPlanAttentionRoutes } from './features/org-plan-attention/register-routes.js';
import type { OrgPlanAttentionReader } from './features/org-plan-attention/application/ports.js';
import type { ListAvailableSkillsDependencies } from './features/skills/list-available/endpoint.js';
import type { ListSkillProfilesDependencies } from './features/skills/list-profiles/endpoint.js';
import type { ReplaceSkillProfileDependencies } from './features/skills/replace-profile/endpoint.js';
import type { DeleteSkillProfileDependencies } from './features/skills/delete-profile/endpoint.js';
import type {
  AuthorizationRepository,
  Clock,
  RandomBytes,
  WebAuthnCeremonyService,
} from './features/auth/application/ports.js';
import type { CeremonyAttemptGate } from './features/auth/application/ceremony-attempts.js';
import { registerAutopilotRoutes } from './features/autopilot/register-routes.js';
import type { AutopilotCoordinator } from './features/autopilot/application/service.js';

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
    skillProfiles: Pick<SkillProfileStore, 'readGlobalProfile' | 'readWorkspaceDefault'>;
    skillCatalog(profile: string): Pick<SkillCatalog, 'list'>;
    defaultSkillProfile?: SkillProfile;
    activate?(
      session: RelaySessionSnapshot,
      settings: StartSessionSettings,
    ): Promise<RelaySessionSnapshot>;
    startTurn?(
      session: RelaySessionSnapshot,
      text: string,
      clientUserMessageId?: string,
    ): Promise<RelaySessionSnapshot>;
    ensureWriter?(session: RelaySessionSnapshot): Promise<WriterAcquisition>;
    releaseWriter?(id: string): void | Promise<void>;
    onTurnStarted?(session: RelaySessionSnapshot): void;
    models?: Pick<ModelCatalog, 'list'>;
    close?(id: string): void | Promise<void>;
    remove?(id: string): void;
    replyInteraction?(sessionId: string, requestId: string, value: unknown): InteractionReplyResult;
    readHistory?(session: RelaySessionSnapshot): Promise<{
      turns: import('./features/sessions/get-history/history-mapper.js').HistoryTurn[];
      activeTurnId: string | null;
    }>;
    currentSequence?(sessionId: string): number;
    agentActivity?(sessionId: string): AgentActivitySnapshot;
    autopilotSnapshot?(
      sessionId: string,
    ): import('./features/autopilot/domain/autopilot-session.js').AutopilotSnapshot;
    autopilotControlTurns?(sessionId: string): ReadonlyMap<string, string>;
    autopilotAudit?(
      sessionId: string,
      limit: number,
    ):
      | readonly import('../shared/contracts/session-event.js').SessionEvent[]
      | {
          events: readonly import('../shared/contracts/session-event.js').SessionEvent[];
          truncated: boolean;
        };
    refreshActivity?(sessionId: string): Promise<void>;
    interruptTurn?(session: RelaySessionSnapshot, turnId: string): Promise<void>;
    restore?(session: RelaySessionSnapshot): Promise<RestoreSessionResult | RelaySessionSnapshot>;
    promoteRecent?(thread: RecentThread): Promise<RelaySessionSnapshot>;
    release?(session: RelaySessionSnapshot): RelaySessionSnapshot;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
    interactionResolved?(
      sessionId: string,
      requestId: string,
      occurredAt: string,
      outcome: SafeInteractionOutcome,
    ): void;
  };
  sessionEvents?: {
    exists(id: string): boolean;
    since(id: string, after: number): SessionEvent[];
    subscribe(id: string, listener: (event: SessionEvent) => void): () => void;
  };
  planRoutes?: {
    exists(id: string): boolean;
    find(id: string): SupervisedPlan | null;
    refresh(id: string): Promise<SupervisedPlan | null>;
    removeStatus(id: string): Promise<void>;
    clear(id: string): void;
    closed(id: string): void;
  };
  workspacePlanRoutes?: {
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    plans: WorkspacePlanCatalogSource;
  };
  planMeasurementRoutes?: {
    exists(id: string): boolean;
    authorize(id: string, authorization: string | undefined): boolean;
    read(
      id: string,
    ): Promise<
      import('./features/plans/application/measurement-snapshot.js').PlanMeasurementSnapshot
    >;
  };
  interactions?: {
    resolve(
      sessionId: string,
      requestId: string,
      resolvedAt: string,
      outcome: SafeInteractionOutcome,
    ): boolean;
    validate?(sessionId: string, requestId: string, value: Record<string, unknown>): boolean;
    alreadyResolved?(
      sessionId: string,
      requestId: string,
    ): { resolvedAt: string; outcome: SafeInteractionOutcome } | null;
    snapshot?(sessionId: string): SafeInteractionSnapshot[];
    pending?(sessionId: string, requestId: string): boolean;
  };
  orgPlanAttention?: {
    exists(id: string): boolean;
    reader: OrgPlanAttentionReader;
    resolver: import('./features/org-plan-attention/application/ports.js').OrgPlanAttentionResolver;
    transitions: import('./features/org-plan-attention/application/ports.js').OrgPlanAttentionTransitions;
  };
  autopilot?: AutopilotCoordinator;
  gitSummary?: {
    workspaces: GitWorkspaceResolver;
    inspect(path: string): Promise<GitSummary>;
    inspectForPush?(path: string): Promise<GitSummary>;
    push(path: string, upstream: string): Promise<void>;
    refresh(path: string): Promise<void>;
    pull?(path: string): Promise<void>;
    checkout?(path: string, branch: string): Promise<void>;
    clone?(path: string, address: string): Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  };
  skills?: ListAvailableSkillsDependencies &
    ListSkillProfilesDependencies &
    ReplaceSkillProfileDependencies &
    DeleteSkillProfileDependencies;
  auth?: {
    repository: AuthorizationRepository;
    clock: Clock;
    random: RandomBytes;
    identifiers: import('./features/auth/application/ports.js').AuthorizationIdentifiers;
    webauthn: WebAuthnCeremonyService;
    relyingParty: { publicOrigin: string; rpId: string; rpName: string };
    ceremonyAttempts?: CeremonyAttemptGate;
  };
  passkeyAuthDisabled?: boolean;
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  // Keep the default boundary finite even when an endpoint forgot a narrower schema.
  const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // WebAuthn is same-origin; explicitly allow only this origin's ceremony calls.
    reply.header(
      'Permissions-Policy',
      'publickey-credentials-get=(self), publickey-credentials-create=(self)',
    );
    return payload;
  });
  await app.register(fastifyCookie);
  if (deps.staticDir) await app.register(fastifyStatic, { root: deps.staticDir });
  if (deps.auth)
    registerAuthorizationBoundary(app, {
      repository: deps.auth.repository,
      clock: deps.auth.clock,
      publicOrigin: deps.auth.relyingParty.publicOrigin,
    });
  registerGetHealth(app, deps.health);
  registerAuthRoutes(app, deps);
  if (deps.bootstrap) registerGetBootstrap(app, deps.bootstrap);
  registerSessionRoutes(app, deps);
  if (deps.autopilot) registerAutopilotRoutes(app, deps.autopilot, deps.sessionRoutes?.idempotency);
  if (deps.orgPlanAttention) registerOrgPlanAttentionRoutes(app, deps.orgPlanAttention);
  registerPlanRoutes(app, deps);
  registerGitRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerProblemHandler(app, Boolean(deps.staticDir));
  return app;
}
