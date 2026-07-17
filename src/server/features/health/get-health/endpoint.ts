/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { HealthResponse } from './response.js';

export interface HealthReader {
  read(): Promise<HealthResponse>;
}

export function registerGetHealth(app: FastifyInstance, health: HealthReader): void {
  app.get('/health', async () => health.read());
}
