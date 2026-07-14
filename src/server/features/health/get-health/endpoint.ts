import type { FastifyInstance } from 'fastify';

import type { HealthResponse } from './response.js';

export interface HealthReader {
  read(): Promise<HealthResponse>;
}

export function registerGetHealth(app: FastifyInstance, health: HealthReader): void {
  app.get('/health', async () => health.read());
}
