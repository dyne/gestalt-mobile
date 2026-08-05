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
  renameDevice(
    id: AuthorizedDevice['id'],
    expectedVersion: number,
    nickname: DeviceNickname,
  ): 'renamed' | 'stale' | 'notFound';
  advanceCounter(
    id: AuthorizedDevice['id'],
    expectedCounter: number,
    expectedVersion: number,
    nextCounter: number,
    usedAt: string,
  ): boolean;
  revokeDevice(
    id: AuthorizedDevice['id'],
    revokedAt: string,
  ): 'revoked' | 'finalDevice' | 'notFound';
  saveCeremony(
    token: PasskeyCeremony['id'],
    ceremony: Omit<PasskeyCeremony, 'id'> & {
      challenge: Uint8Array;
      expectedOrigin: string;
      rpId: string;
      enrollmentTicket?: EnrollmentTicket['id'];
    },
    now?: string,
  ): void;
  consumeCeremony(
    token: PasskeyCeremony['id'],
    now: string,
  ): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null;
  readCeremony(
    token: PasskeyCeremony['id'],
    now: string,
  ): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null;
  saveTicket(token: EnrollmentTicket['id'], ticket: Omit<EnrollmentTicket, 'id'>): void;
  issueEnrollmentTicket(
    token: EnrollmentTicket['id'],
    creatorSession: AuthorizationSession['id'],
    expiresAt: string,
  ): void;
  enrollmentTicketStatus(
    creatorSession: AuthorizationSession['id'],
    now: string,
  ): 'none' | 'pending' | 'used' | 'expired';
  cancelEnrollmentTicket(creatorSession: AuthorizationSession['id'], now: string): boolean;
  consumeTicket(token: EnrollmentTicket['id'], now: string): boolean;
  ticketAvailable(token: EnrollmentTicket['id'], now: string): boolean;
  completeRegistration(input: {
    ceremony: PasskeyCeremony['id'];
    now: string;
    device: AuthorizedDevice;
    session: AuthorizationSession;
  }):
    | 'registered'
    | 'bootstrapAlreadyClaimed'
    | 'ticketUnavailable'
    | 'duplicateCredential'
    | 'ceremonyUnavailable';
  completeAuthentication(input: {
    ceremony: PasskeyCeremony['id'];
    now: string;
    device: AuthorizedDevice;
    nextCounter: number;
    session: AuthorizationSession;
  }): boolean;
  saveSession(token: AuthorizationSession['id'], session: Omit<AuthorizationSession, 'id'>): void;
  sessionDevice(token: AuthorizationSession['id'], now: string): AuthorizedDevice['id'] | null;
  revokeSession(token: AuthorizationSession['id'], now: string): boolean;
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
  deviceId(): AuthorizedDevice['id'];
}

export interface PasskeyOptions {
  challenge: Uint8Array;
  rpId: string;
  userVerification: 'required';
}

/** Plain application input; adapters own library-specific option shapes. */
export type RegistrationOptionsInput = PasskeyOptions & {
  rpName: string;
  userHandle: Uint8Array;
  excludeCredentialIds: readonly WebAuthnCredentialId[];
};

export interface PasskeyVerification {
  credentialId: WebAuthnCredentialId;
  counter: number;
  userVerified: boolean;
}

export type RegistrationVerification = PasskeyVerification & {
  publicKey: Uint8Array;
  transports: readonly ('ble' | 'hybrid' | 'internal' | 'nfc' | 'usb')[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
};

export interface WebAuthnCeremonyService {
  registrationOptions(input: RegistrationOptionsInput): Promise<unknown>;
  authenticationOptions(input: PasskeyOptions): Promise<unknown>;
  verifyRegistration(input: {
    response: unknown;
    challenge: Uint8Array;
    expectedOrigin: string;
    rpId: string;
  }): Promise<RegistrationVerification>;
  verifyAuthentication(input: unknown): Promise<PasskeyVerification>;
}

/** Expected proof failure; adapters must translate library-specific failures to this type. */
export class PasskeyVerificationError extends Error {}

export interface AuthorizationSessionCookieDelivery {
  deliver(session: AuthorizationSession): void;
  clear(): void;
}

export type RenameAuthorizedDevice = Readonly<{
  deviceId: AuthorizedDevice['id'];
  nickname: DeviceNickname;
}>;
