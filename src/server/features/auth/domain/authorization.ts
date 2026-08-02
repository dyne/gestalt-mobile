/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  AuthorizationSessionId,
  AuthorizedDeviceId,
  EnrollmentTicketId,
  LocalOwnerId,
  PasskeyCeremonyId,
  WebAuthnCredentialId,
} from './identifiers.js';
import type { DeviceNickname } from './device-nickname.js';
import { AuthorizationDomainError } from './errors.js';

export type CredentialTransport = 'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb';
export type CredentialDeviceType = 'singleDevice' | 'multiDevice';
export type CeremonyPurpose = 'registration' | 'authentication' | 'enrollment';

export type LocalOwner = Readonly<{
  id: LocalOwnerId;
  /** Random opaque WebAuthn user handle. */
  userHandle: Uint8Array;
}>;

export type AuthorizedDevice = Readonly<{
  id: AuthorizedDeviceId;
  credentialId: WebAuthnCredentialId;
  publicKey: Uint8Array;
  counter: number;
  transports: readonly CredentialTransport[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  nickname: DeviceNickname;
  createdAt: string;
  lastUsedAt?: string;
  /** Optimistic-concurrency revision owned by the authorization repository. */
  version?: number;
}>;

export type PasskeyCeremony = Readonly<{
  id: PasskeyCeremonyId;
  purpose: CeremonyPurpose;
  expiresAt: string;
}>;

export type EnrollmentTicket = Readonly<{
  id: EnrollmentTicketId;
  expiresAt: string;
}>;

export type AuthorizationSession = Readonly<{
  id: AuthorizationSessionId;
  deviceId: AuthorizedDeviceId;
  expiresAt: string;
}>;

export type FirstDeviceAuthorized = Readonly<{ kind: 'firstDeviceAuthorized'; device: AuthorizedDevice }>;
export type DeviceAuthorized = Readonly<{ kind: 'deviceAuthorized'; device: AuthorizedDevice }>;
export type DeviceRenamed = Readonly<{ kind: 'deviceRenamed'; device: AuthorizedDevice }>;
export type DeviceRevoked = Readonly<{ kind: 'deviceRevoked'; deviceId: AuthorizedDeviceId }>;

export class LocalOwnerAuthorization {
  private constructor(
    private readonly ownerValue: LocalOwner,
    private readonly devices: readonly AuthorizedDevice[],
  ) {}

  static bootstrap(
    owner: LocalOwner,
    firstDevice: AuthorizedDevice,
  ): LocalOwnerAuthorization & { outcome: FirstDeviceAuthorized } {
    const device = copyDevice(firstDevice);
    assertUniqueDeviceIds([device]);
    return withOutcome(new LocalOwnerAuthorization(copyOwner(owner), [device]), {
      kind: 'firstDeviceAuthorized',
      device: copyDevice(device),
    });
  }

  static rehydrate(owner: LocalOwner, devices: readonly AuthorizedDevice[]): LocalOwnerAuthorization {
    if (devices.length < 1) throw new AuthorizationDomainError('AUTHORIZED_DEVICE_REQUIRED');
    assertUniqueDeviceIds(devices);
    assertUniqueCredentials(devices);
    return new LocalOwnerAuthorization(copyOwner(owner), devices.map(copyDevice));
  }

  get owner(): LocalOwner {
    return copyOwner(this.ownerValue);
  }

  get authorizedDevices(): readonly AuthorizedDevice[] {
    return this.devices.map(copyDevice);
  }

  authorizeDevice(device: AuthorizedDevice): LocalOwnerAuthorization & { outcome: DeviceAuthorized } {
    assertUniqueDeviceIds([...this.devices, device]);
    assertUniqueCredentials([...this.devices, device]);
    return withOutcome(
      new LocalOwnerAuthorization(this.ownerValue, [...this.devices, copyDevice(device)]),
      { kind: 'deviceAuthorized', device: copyDevice(device) },
    );
  }

  renameDevice(id: AuthorizedDeviceId, nickname: DeviceNickname): LocalOwnerAuthorization & { outcome: DeviceRenamed } {
    const device = this.requireDevice(id);
    const renamed = { ...device, nickname };
    return withOutcome(
      new LocalOwnerAuthorization(this.ownerValue, this.devices.map((entry) => (entry.id === id ? renamed : entry))),
      { kind: 'deviceRenamed', device: copyDevice(renamed) },
    );
  }

  recordAssertion(id: AuthorizedDeviceId, counter: number, usedAt: string): LocalOwnerAuthorization {
    const device = this.requireDevice(id);
    if (!Number.isInteger(counter) || counter < 0) throw new AuthorizationDomainError('CREDENTIAL_COUNTER_INVALID');
    const allowsZeroCounter = device.counter === 0 && counter === 0 && device.deviceType === 'multiDevice';
    if (!allowsZeroCounter && counter <= device.counter)
      throw new AuthorizationDomainError('CREDENTIAL_COUNTER_NOT_MONOTONIC');
    const updated = { ...device, counter, lastUsedAt: usedAt };
    return new LocalOwnerAuthorization(
      this.ownerValue,
      this.devices.map((entry) => (entry.id === id ? updated : entry)),
    );
  }

  revokeDevice(id: AuthorizedDeviceId): LocalOwnerAuthorization & { outcome: DeviceRevoked } {
    this.requireDevice(id);
    if (this.devices.length === 1) throw new AuthorizationDomainError('AUTHORIZED_DEVICE_REQUIRED');
    return withOutcome(
      new LocalOwnerAuthorization(this.ownerValue, this.devices.filter((device) => device.id !== id)),
      { kind: 'deviceRevoked', deviceId: id },
    );
  }

  private requireDevice(id: AuthorizedDeviceId): AuthorizedDevice {
    const device = this.devices.find((entry) => entry.id === id);
    if (!device) throw new AuthorizationDomainError('AUTHORIZED_DEVICE_NOT_FOUND');
    return device;
  }
}

function withOutcome<T extends LocalOwnerAuthorization, Outcome>(value: T, outcome: Outcome): T & { outcome: Outcome } {
  return Object.freeze(Object.assign(value, { outcome }));
}

function assertUniqueCredentials(devices: readonly AuthorizedDevice[]): void {
  if (new Set(devices.map((device) => device.credentialId)).size !== devices.length)
    throw new AuthorizationDomainError('CREDENTIAL_ALREADY_AUTHORIZED');
}

function assertUniqueDeviceIds(devices: readonly AuthorizedDevice[]): void {
  if (new Set(devices.map((device) => device.id)).size !== devices.length)
    throw new AuthorizationDomainError('AUTHORIZED_DEVICE_ID_ALREADY_AUTHORIZED');
}

function copyOwner(owner: LocalOwner): LocalOwner {
  if (owner.userHandle.length < 1) throw new AuthorizationDomainError('LOCAL_OWNER_HANDLE_INVALID');
  return Object.freeze({ ...owner, userHandle: new Uint8Array(owner.userHandle) });
}

function copyDevice(device: AuthorizedDevice): AuthorizedDevice {
  if (!Number.isInteger(device.counter) || device.counter < 0)
    throw new AuthorizationDomainError('CREDENTIAL_COUNTER_INVALID');
  if (device.version !== undefined && (!Number.isInteger(device.version) || device.version < 0))
    throw new AuthorizationDomainError('AUTHORIZED_DEVICE_VERSION_INVALID');
  if (device.publicKey.length < 1) throw new AuthorizationDomainError('CREDENTIAL_PUBLIC_KEY_INVALID');
  if (Number.isNaN(Date.parse(device.createdAt))) throw new AuthorizationDomainError('AUTHORIZED_DEVICE_TIMESTAMP_INVALID');
  if (device.lastUsedAt && Number.isNaN(Date.parse(device.lastUsedAt)))
    throw new AuthorizationDomainError('AUTHORIZED_DEVICE_TIMESTAMP_INVALID');
  return Object.freeze({
    ...device,
    version: device.version ?? 0,
    publicKey: new Uint8Array(device.publicKey),
    transports: Object.freeze([...device.transports]),
  });
}
