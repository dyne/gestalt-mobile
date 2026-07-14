import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';

import { registerGetHealth, type HealthReader } from './features/health/get-health/endpoint.js';
import { registerProblemHandler } from './platform/http/problem-handler.js';

export type AppDependencies = {
  health: HealthReader;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  staticDir?: string;
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  if (deps.staticDir) await app.register(fastifyStatic, { root: deps.staticDir });
  registerGetHealth(app, deps.health);
  registerProblemHandler(app, Boolean(deps.staticDir));
  return app;
}
