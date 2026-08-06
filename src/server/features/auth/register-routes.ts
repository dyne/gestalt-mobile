/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { ExpiringCeremonyAttemptGate } from './application/ceremony-attempts.js';
import { registerListAuthorizedDevices } from './devices/list/endpoint.js';
import { registerRenameAuthorizedDevice } from './devices/rename/endpoint.js';
import { registerRevokeAuthorizedDevice } from './devices/revoke/endpoint.js';
import { registerCancelEnrollmentTicket } from './enrollment-tickets/cancel/endpoint.js';
import { registerCreateEnrollmentTicket } from './enrollment-tickets/endpoint.js';
import { registerEnrollmentTicketStatus } from './enrollment-tickets/status/endpoint.js';
import { registerLoginOptions } from './login/options/endpoint.js';
import { registerLoginVerification } from './login/verify/endpoint.js';
import { registerLogout } from './logout/endpoint.js';
import { registerRegistrationOptions } from './register/options/endpoint.js';
import { registerRegistrationVerification } from './register/verify/endpoint.js';
import { registerAuthStatus, registerDisabledAuthStatus } from './status/endpoint.js';

/** Registers the complete passkey surface; authorization hooks are composed by app.ts first. */
export function registerAuthRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'auth' | 'passkeyAuthDisabled'>,
): void {
  if (deps.auth) {
    const auth = {
      ...deps.auth,
      ceremonyAttempts: deps.auth.ceremonyAttempts ?? new ExpiringCeremonyAttemptGate(),
    };
    registerRegistrationOptions(app, auth);
    registerRegistrationVerification(app, deps.auth);
    registerLoginOptions(app, auth);
    registerLoginVerification(app, deps.auth);
    registerAuthStatus(app, deps.auth);
    registerLogout(app, deps.auth);
    registerListAuthorizedDevices(app, deps.auth);
    registerRenameAuthorizedDevice(app, deps.auth);
    registerRevokeAuthorizedDevice(app, deps.auth);
    registerCreateEnrollmentTicket(app, deps.auth);
    registerEnrollmentTicketStatus(app, deps.auth);
    registerCancelEnrollmentTicket(app, deps.auth);
  } else if (deps.passkeyAuthDisabled) registerDisabledAuthStatus(app);
}
