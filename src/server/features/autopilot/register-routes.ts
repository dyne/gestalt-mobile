/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { AutopilotCoordinator } from './application/service.js';
import { registerAutopilotToggle } from './toggle/endpoint.js';

export function registerAutopilotRoutes(
  app: FastifyInstance,
  coordinator: AutopilotCoordinator,
  idempotency?: {
    get(scope: string, key: string): { statusCode: number; body: string } | null;
    put(scope: string, key: string, statusCode: number, body: string): void;
  },
): void {
  registerAutopilotToggle(app, coordinator, idempotency);
}
