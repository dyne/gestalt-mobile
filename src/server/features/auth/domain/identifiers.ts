/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AuthorizationDomainError } from './errors.js';

declare const localOwnerIdBrand: unique symbol;
declare const authorizedDeviceIdBrand: unique symbol;
declare const credentialIdBrand: unique symbol;
declare const ceremonyIdBrand: unique symbol;
declare const enrollmentTicketIdBrand: unique symbol;
declare const authorizationSessionIdBrand: unique symbol;

export type LocalOwnerId = string & { readonly [localOwnerIdBrand]: 'LocalOwnerId' };
export type AuthorizedDeviceId = string & {
  readonly [authorizedDeviceIdBrand]: 'AuthorizedDeviceId';
};
export type WebAuthnCredentialId = string & {
  readonly [credentialIdBrand]: 'WebAuthnCredentialId';
};
export type PasskeyCeremonyId = string & { readonly [ceremonyIdBrand]: 'PasskeyCeremonyId' };
export type EnrollmentTicketId = string & {
  readonly [enrollmentTicketIdBrand]: 'EnrollmentTicketId';
};
export type AuthorizationSessionId = string & {
  readonly [authorizationSessionIdBrand]: 'AuthorizationSessionId';
};

export function localOwnerId(value: string): LocalOwnerId {
  return opaqueId(value, 'LOCAL_OWNER_ID_INVALID') as LocalOwnerId;
}
export function authorizedDeviceId(value: string): AuthorizedDeviceId {
  return opaqueId(value, 'AUTHORIZED_DEVICE_ID_INVALID') as AuthorizedDeviceId;
}
export function webAuthnCredentialId(value: string): WebAuthnCredentialId {
  return opaqueId(value, 'CREDENTIAL_ID_INVALID') as WebAuthnCredentialId;
}
export function passkeyCeremonyId(value: string): PasskeyCeremonyId {
  return opaqueId(value, 'PASSKEY_CEREMONY_ID_INVALID') as PasskeyCeremonyId;
}
export function enrollmentTicketId(value: string): EnrollmentTicketId {
  const parsed = parseEnrollmentTicketId(value);
  if (parsed === null) throw new AuthorizationDomainError('ENROLLMENT_TICKET_ID_INVALID');
  return parsed;
}
export function authorizationSessionId(value: string): AuthorizationSessionId {
  const parsed = parseAuthorizationSessionId(value);
  if (parsed === null) throw new AuthorizationDomainError('AUTHORIZATION_SESSION_ID_INVALID');
  return parsed;
}

export function parseEnrollmentTicketId(value: unknown): EnrollmentTicketId | null {
  return opaqueIdOrNull(value) as EnrollmentTicketId | null;
}

export function parseAuthorizationSessionId(value: unknown): AuthorizationSessionId | null {
  return opaqueIdOrNull(value) as AuthorizationSessionId | null;
}

function opaqueId(value: string, code: string): string {
  const parsed = opaqueIdOrNull(value);
  if (parsed === null) throw new AuthorizationDomainError(code);
  return parsed;
}

function opaqueIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}
