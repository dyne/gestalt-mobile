/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthorizationRepository } from '../../features/auth/application/ports.js';
import { parseAuthorizationSessionId } from '../../features/auth/domain/identifiers.js';
import type {
  PreviewAuthentication,
  PreviewSecrets,
} from '../../features/live-design/application/ports.js';

export const previewSecrets: PreviewSecrets = {
  token: () => randomBytes(32).toString('base64url'),
  id: () => randomUUID(),
  hash: (value) => createHash('sha256').update(value).digest('hex'),
  challenge: (value) => createHash('sha256').update(value, 'ascii').digest('base64url'),
  equal: (left, right) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  },
};

export function cookieValue(header: string | undefined, name: string): string | undefined {
  const values = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return value || undefined;
}

export function previewAuthentication(repository: AuthorizationRepository): PreviewAuthentication {
  return {
    identity(cookie, now) {
      const session = parseAuthorizationSessionId(cookieValue(cookie, 'gestalt_mobile_session'));
      if (!session || !repository.sessionDeviceByHash) return null;
      const deviceId = repository.sessionDevice(session, now);
      return deviceId ? { authSessionHash: previewSecrets.hash(session), deviceId } : null;
    },
    authorized(hash, deviceId, now) {
      return repository.sessionDeviceByHash?.(hash, now) === deviceId;
    },
  };
}
