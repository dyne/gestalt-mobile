/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AuthorizationRepository } from '../application/ports.js';
import type { AuthorizedDevice } from '../domain/authorization.js';
import { deviceNickname, type DeviceNickname } from '../domain/device-nickname.js';

export type AuthorizedDeviceMetadata = Readonly<{
  id: string;
  nickname: string;
  createdAt: string;
  lastUsedAt?: string;
  current: boolean;
}>;

/** Maps a credential to deliberately non-WebAuthn management metadata. */
export function listAuthorizedDeviceMetadata(
  repository: Pick<AuthorizationRepository, 'listAuthorizedDevices'>,
  currentDeviceId: AuthorizedDevice['id'] | null,
): readonly AuthorizedDeviceMetadata[] {
  return repository.listAuthorizedDevices().map((device) => ({
    id: device.id,
    nickname: device.nickname,
    createdAt: device.createdAt,
    ...(device.lastUsedAt === undefined ? {} : { lastUsedAt: device.lastUsedAt }),
    current: device.id === currentDeviceId,
  }));
}

export function renameAuthorizedDevice(
  repository: Pick<AuthorizationRepository, 'findDevice' | 'renameDevice'>,
  id: AuthorizedDevice['id'],
  nickname: string,
): 'renamed' | 'stale' | 'notFound' {
  const validated: DeviceNickname = deviceNickname(nickname);
  const current = repository.findDevice(id);
  if (!current) return 'notFound';
  return repository.renameDevice(id, current.version ?? 0, validated);
}

export function revokeAuthorizedDevice(
  repository: Pick<AuthorizationRepository, 'revokeDevice'>,
  id: AuthorizedDevice['id'],
  revokedAt: string,
): 'revoked' | 'finalDevice' | 'notFound' {
  return repository.revokeDevice(id, revokedAt);
}
