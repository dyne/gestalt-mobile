/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AuthorizationRepository, Clock } from '../../features/auth/application/ports.js';
import { authorizationSessionId } from '../../features/auth/domain/identifiers.js';
import { problem } from './problem.js';

const publicApi = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/register/options',
  'POST /api/auth/register/verify',
]);

export type AuthorizationBoundaryDependencies = {
  repository: AuthorizationRepository;
  clock: Clock;
  publicOrigin: string;
};

export function registerAuthorizationBoundary(
  app: FastifyInstance,
  deps: AuthorizationBoundaryDependencies,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (isUnsafe(request.method) && request.headers.origin !== deps.publicOrigin)
      return reply
        .code(403)
        .type('application/problem+json')
        .send(problem('ORIGIN_NOT_ALLOWED', 403, 'The request origin is not allowed.'));
    if (publicApi.has(`${request.method} ${request.routeOptions.url}`)) return;
    if (authorizationSessionDevice(request.headers.cookie, deps) !== null) return;
    return reply
      .code(401)
      .type('application/problem+json')
      .send(problem('AUTH_REQUIRED', 401, 'Authentication is required.'));
  });
}

/** Shared by HTTP and raw WebSocket upgrades; the opaque cookie is never logged. */
export function authorizationSessionDevice(
  cookieHeader: string | undefined,
  deps: Pick<AuthorizationBoundaryDependencies, 'repository' | 'clock'>,
) {
  const token = cookieValue(cookieHeader, 'gestalt_mobile_session');
  return token === undefined
    ? null
    : deps.repository.sessionDevice(authorizationSessionId(token), deps.clock.now().toISOString());
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    const candidate = value.join('=');
    if (!candidate || found !== undefined) return undefined;
    found = candidate;
  }
  return found;
}

function isUnsafe(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
