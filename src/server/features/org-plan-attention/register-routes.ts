/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { OrgPlanAttentionReader } from './application/ports.js';
import { registerGetActiveOrgPlanAttention } from './get-active/endpoint.js';
import { registerResolveOrgPlanAttention } from './resolve/endpoint.js';

export function registerOrgPlanAttentionRoutes(
  app: FastifyInstance,
  deps: {
    exists(sessionId: string): boolean;
    reader: OrgPlanAttentionReader;
    resolver: import('./application/ports.js').OrgPlanAttentionResolver;
  },
): void {
  registerGetActiveOrgPlanAttention(app, deps);
  registerResolveOrgPlanAttention(app, deps);
}
