/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  AuthorizationSession,
  AuthorizedDevice,
  EnrollmentTicket,
  LocalOwner,
  PasskeyCeremony,
} from '../domain/authorization.js';
import type { DeviceNickname } from '../domain/device-nickname.js';
import type { AuthorizationSessionId, WebAuthnCredentialId } from '../domain/identifiers.js';

export interface AuthorizationRepository {
  initializeOwner(userHandle: Uint8Array): LocalOwner;
  readOwner(): LocalOwner | null;
  listAuthorizedDevices(): readonly AuthorizedDevice[];
  claimFirstDevice(owner: LocalOwner, device: AuthorizedDevice): 'claimed' | 'alreadyClaimed';
  authorizeDevice(device: AuthorizedDevice): 'authorized' | 'notAuthorized' | 'duplicateCredential';
  findDeviceByCredentialId(credentialId: WebAuthnCredentialId): AuthorizedDevice | null;
  findDevice(id: AuthorizedDevice['id']): AuthorizedDevice | null;
  renameDevice(id: AuthorizedDevice['id'], expectedVersion: number, nickname: DeviceNickname): 'renamed' | 'stale' | 'notFound';
  advanceCounter(id: AuthorizedDevice['id'], expectedCounter: number, expectedVersion: number, nextCounter: number, usedAt: string): boolean;
  revokeDevice(id: AuthorizedDevice['id'], revokedAt: string): 'revoked' | 'finalDevice' | 'notFound';
  saveCeremony(token: PasskeyCeremony['id'], ceremony: Omit<PasskeyCeremony, 'id'> & { challenge: Uint8Array; expectedOrigin: string; rpId: string }): void;
  consumeCeremony(token: PasskeyCeremony['id'], now: string): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null;
  saveTicket(token: EnrollmentTicket['id'], ticket: Omit<EnrollmentTicket, 'id'>): void;
  consumeTicket(token: EnrollmentTicket['id'], now: string): boolean;
  saveSession(token: AuthorizationSession['id'], session: Omit<AuthorizationSession, 'id'>): void;
  sessionDevice(token: AuthorizationSession['id'], now: string): AuthorizedDevice['id'] | null;
  close(): void;
}

export interface Clock {
  now(): Date;
}

export interface RandomBytes {
  bytes(length: number): Uint8Array;
}

export interface AuthorizationIdentifiers {
  sessionId(): AuthorizationSessionId;
}

export interface PasskeyOptions {
  challenge: Uint8Array;
  rpId: string;
  userVerification: 'required';
}

export interface PasskeyVerification {
  credentialId: WebAuthnCredentialId;
  counter: number;
  userVerified: boolean;
}

export interface WebAuthnCeremonyService {
  registrationOptions(input: PasskeyOptions): Promise<unknown>;
  authenticationOptions(input: PasskeyOptions): Promise<unknown>;
  verifyRegistration(input: unknown): Promise<PasskeyVerification>;
  verifyAuthentication(input: unknown): Promise<PasskeyVerification>;
}

export interface AuthorizationSessionCookieDelivery {
  deliver(session: AuthorizationSession): void;
  clear(): void;
}

export type RenameAuthorizedDevice = Readonly<{ deviceId: AuthorizedDevice['id']; nickname: DeviceNickname }>;
