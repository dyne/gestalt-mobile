/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { LocalOwnerAuthorization, type AuthorizedDevice } from './authorization.js';
import { deviceNickname } from './device-nickname.js';
import { AuthorizationDomainError } from './errors.js';
import { authorizedDeviceId, localOwnerId, webAuthnCredentialId } from './identifiers.js';

const owner = { id: localOwnerId('owner-1'), userHandle: new Uint8Array([1, 2, 3]) };
const device = (id: string, credential: string, type: AuthorizedDevice['deviceType'] = 'singleDevice') => ({
  id: authorizedDeviceId(id),
  credentialId: webAuthnCredentialId(credential),
  publicKey: new Uint8Array([1, 2]),
  counter: 0,
  transports: ['internal'] as const,
  deviceType: type,
  backedUp: type === 'multiDevice',
  nickname: deviceNickname(`Device ${id}`),
  createdAt: '2026-08-02T00:00:00.000Z',
});

describe('DeviceNickname', () => {
  it('trims Unicode whitespace and counts Unicode code points', () => {
    expect(deviceNickname('  \u{1F680} Phone  ')).toBe('\u{1F680} Phone');
    expect(deviceNickname('🧭'.repeat(64))).toHaveLength(128);
  });

  it('refuses empty and overlong nicknames', () => {
    expect(() => deviceNickname('   ')).toThrow(new AuthorizationDomainError('DEVICE_NICKNAME_INVALID'));
    expect(() => deviceNickname(' \u00a0 ')).toThrow(new AuthorizationDomainError('DEVICE_NICKNAME_INVALID'));
    expect(() => deviceNickname('a'.repeat(65))).toThrow(new AuthorizationDomainError('DEVICE_NICKNAME_INVALID'));
  });
});

describe('LocalOwnerAuthorization', () => {
  it('keeps owner, device, and credential identities opaque and distinct', () => {
    expect(() => localOwnerId(' owner')).toThrow('LOCAL_OWNER_ID_INVALID');
    expect(() => authorizedDeviceId('')).toThrow('AUTHORIZED_DEVICE_ID_INVALID');
    expect(webAuthnCredentialId('credential-1')).toBe('credential-1');
  });

  it('starts with a first device and rejects duplicate credentials', () => {
    const authorization = LocalOwnerAuthorization.bootstrap(owner, device('device-1', 'credential-1'));
    expect(authorization.outcome.kind).toBe('firstDeviceAuthorized');
    expect(authorization.authorizedDevices).toHaveLength(1);
    expect(() => authorization.authorizeDevice(device('device-2', 'credential-1'))).toThrow(
      new AuthorizationDomainError('CREDENTIAL_ALREADY_AUTHORIZED'),
    );
  });

  it('rejects duplicate authorized-device identities', () => {
    const authorization = LocalOwnerAuthorization.bootstrap(owner, device('device-1', 'credential-1'));
    expect(() => authorization.authorizeDevice(device('device-1', 'credential-2'))).toThrow(
      new AuthorizationDomainError('AUTHORIZED_DEVICE_ID_ALREADY_AUTHORIZED'),
    );
    expect(() => LocalOwnerAuthorization.rehydrate(owner, [device('device-1', 'credential-1'), device('device-1', 'credential-2')])).toThrow(
      new AuthorizationDomainError('AUTHORIZED_DEVICE_ID_ALREADY_AUTHORIZED'),
    );
  });

  it('does not expose mutable owner or credential key bytes', () => {
    const authorization = LocalOwnerAuthorization.bootstrap(owner, device('device-1', 'credential-1'));
    authorization.owner.userHandle[0] = 99;
    authorization.outcome.device.publicKey[0] = 99;
    authorization.authorizedDevices[0]!.publicKey[0] = 99;

    expect(authorization.owner.userHandle).toEqual(new Uint8Array([1, 2, 3]));
    expect(authorization.authorizedDevices[0]!.publicKey).toEqual(new Uint8Array([1, 2]));
    expect(
      authorization.recordAssertion(authorizedDeviceId('device-1'), 1, '2026-08-02T01:00:00.000Z').authorizedDevices[0]
        ?.publicKey,
    ).toEqual(new Uint8Array([1, 2]));
  });

  it('requires monotonic assertion counters but supports zero-counter synced credentials', () => {
    const single = LocalOwnerAuthorization.bootstrap(owner, device('device-1', 'credential-1'));
    expect(() => single.recordAssertion(authorizedDeviceId('device-1'), 0, '2026-08-02T01:00:00.000Z')).toThrow(
      new AuthorizationDomainError('CREDENTIAL_COUNTER_NOT_MONOTONIC'),
    );
    const advanced = single.recordAssertion(authorizedDeviceId('device-1'), 1, '2026-08-02T01:00:00.000Z');
    expect(advanced.authorizedDevices[0]).toMatchObject({ counter: 1, lastUsedAt: '2026-08-02T01:00:00.000Z' });

    const synced = LocalOwnerAuthorization.bootstrap(owner, device('device-2', 'credential-2', 'multiDevice'));
    expect(synced.recordAssertion(authorizedDeviceId('device-2'), 0, '2026-08-02T01:00:00.000Z').authorizedDevices[0]?.counter).toBe(0);
  });

  it('returns explicit first-device, rename, and revoke outcomes while preserving the final device', () => {
    const first = LocalOwnerAuthorization.bootstrap(owner, device('device-1', 'credential-1'));
    expect(() => first.revokeDevice(authorizedDeviceId('device-1'))).toThrow(
      new AuthorizationDomainError('AUTHORIZED_DEVICE_REQUIRED'),
    );
    const second = first.authorizeDevice(device('device-2', 'credential-2'));
    expect(second.outcome.kind).toBe('deviceAuthorized');
    const renamed = second.renameDevice(authorizedDeviceId('device-2'), deviceNickname('  Tablet  '));
    expect(renamed.outcome).toMatchObject({ kind: 'deviceRenamed', device: { nickname: 'Tablet' } });
    expect(renamed.revokeDevice(authorizedDeviceId('device-2')).outcome).toEqual({
      kind: 'deviceRevoked',
      deviceId: authorizedDeviceId('device-2'),
    });
  });
});
