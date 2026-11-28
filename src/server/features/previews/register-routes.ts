/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { PreviewService } from './application/service.js';
import { registerOpenPreview } from './open-preview/endpoint.js';
import { registerStopPreview } from './stop-preview/endpoint.js';

export type PreviewRoutes = {
  service: Pick<PreviewService, 'open' | 'stop'>;
  origin: string;
  impeccableAvailable?(sessionId: string): boolean | Promise<boolean>;
};

export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewRoutes): void {
  registerOpenPreview(app, deps);
  registerStopPreview(app, deps.service);
}
