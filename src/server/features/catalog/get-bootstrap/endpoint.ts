import type { FastifyInstance } from 'fastify';
import { getBootstrap, type BootstrapDependencies } from './use-case.js';
export function registerGetBootstrap(app: FastifyInstance, deps: BootstrapDependencies): void {
  app.get('/api/bootstrap', async () => getBootstrap(deps));
}
