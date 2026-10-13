/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PreviewOriginAssignment } from '../../features/live-design/application/routes.js';
import { ManagedCaddyAdminBoundary } from './caddy-admin-boundary.js';
import { CaddyRoutes } from './caddy-routes.js';

const operation = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('activate'),
      appRoot: z.string().min(1).max(4096),
      registrationId: z.uuid(),
    })
    .strict(),
  z.object({ action: z.literal('remove'), appRoot: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('reconcile') }).strict(),
]);

/** Private authenticated controller boundary. Never register as a Mobile/project HTTP endpoint. */
export class CaddyRouteBroker {
  private readonly credentialHash: Buffer;
  constructor(
    credential: string,
    private readonly routes: CaddyRoutes,
    private readonly boundary: ManagedCaddyAdminBoundary,
  ) {
    if (credential.length < 32) throw new Error('LIVE_CADDY_CREDENTIAL_INVALID');
    this.credentialHash = createHash('sha256').update(credential).digest();
  }
  async execute(credential: string, command: unknown): Promise<PreviewOriginAssignment | void> {
    const supplied = createHash('sha256').update(credential).digest();
    if (!timingSafeEqual(supplied, this.credentialHash))
      throw new Error('LIVE_CADDY_CONTROLLER_REQUIRED');
    const parsed = operation.safeParse(command);
    if (!parsed.success) throw new Error('LIVE_CADDY_OPERATION_REJECTED');
    await this.boundary.verify();
    switch (parsed.data.action) {
      case 'activate':
        return this.routes.activate(parsed.data.appRoot, parsed.data.registrationId);
      case 'remove':
        return this.routes.remove(parsed.data.appRoot);
      case 'reconcile':
        return this.routes.reconcile();
    }
  }
}
