/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { SqliteAuthorizationStore } from '../../src/server/platform/auth/sqlite-authorization-store.js';
import {
  authorizedDeviceId,
  webAuthnCredentialId,
} from '../../src/server/features/auth/domain/identifiers.js';
import { deviceNickname } from '../../src/server/features/auth/domain/device-nickname.js';

type Mode = 'first-claim' | 'revoke';
type Config = Readonly<{ home: string; mode: Mode; id: string }>;

const rp = {
  publicOrigin: 'http://localhost:3000',
  rpId: 'localhost',
  rpName: 'Gestalt Mobile' as const,
};

function device(id: string) {
  return {
    id: authorizedDeviceId(id),
    credentialId: webAuthnCredentialId(`credential-${id}`),
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname(id),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}

process.once('message', (value: Config) => {
  let store: SqliteAuthorizationStore | undefined;
  process.send?.({ type: 'ready' });
  process.once('message', (command: 'go') => {
    if (command !== 'go') return;
    try {
      store = new SqliteAuthorizationStore(value.home, rp);
      try {
        const outcome =
          value.mode === 'first-claim'
            ? store.claimFirstDevice(
                store.initializeOwner(new Uint8Array(32).fill(1)),
                device(value.id),
              )
            : store.revokeDevice(authorizedDeviceId(value.id), '2026-08-02T01:00:00.000Z');
        process.send?.({ type: 'result', outcome });
      } catch {
        process.send?.({ type: 'error' });
      } finally {
        store?.close();
        process.disconnect();
      }
    } catch (error) {
      store?.close();
      process.send?.({
        type: 'error',
        reason:
          error instanceof Error && error.message.includes('database is locked')
            ? 'database locked'
            : 'store operation failed',
      });
      process.disconnect();
    }
  });
});
