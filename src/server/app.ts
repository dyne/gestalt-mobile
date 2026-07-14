import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';

import { registerGetHealth, type HealthReader } from './features/health/get-health/endpoint.js';
import { registerGetBootstrap } from './features/catalog/get-bootstrap/endpoint.js';
import type { BootstrapDependencies } from './features/catalog/get-bootstrap/use-case.js';
import type { ProfileCatalog, WorkspaceCatalog } from './features/catalog/application/ports.js';
import { registerGetSession } from './features/sessions/get-session/endpoint.js';
import { registerStartSession } from './features/sessions/start-session/endpoint.js';
import type { RelaySessionSnapshot } from './features/sessions/model/relay-session.js';
import { registerProblemHandler } from './platform/http/problem-handler.js';

export type AppDependencies = {
  health: HealthReader;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  staticDir?: string;
  bootstrap?: BootstrapDependencies;
  sessionRoutes?: {
    createId(): string;
    now(): string;
    save(session: RelaySessionSnapshot): void;
    find(id: string): RelaySessionSnapshot | null;
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    profiles: Pick<ProfileCatalog, 'require'>;
    activate?(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
  };
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  if (deps.staticDir) await app.register(fastifyStatic, { root: deps.staticDir });
  registerGetHealth(app, deps.health);
  if (deps.bootstrap) registerGetBootstrap(app, deps.bootstrap);
  if (deps.sessionRoutes) {
    registerStartSession(app, deps.sessionRoutes);
    registerGetSession(app, deps.sessionRoutes.find);
  }
  registerProblemHandler(app, Boolean(deps.staticDir));
  return app;
}
