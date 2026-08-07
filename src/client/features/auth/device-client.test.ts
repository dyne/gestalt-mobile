/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { createDeviceClient } from './device-client.js';

describe('device client mutations', () => {
  it('tolerates successful empty rename and revoke responses', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createDeviceClient(fetcher as typeof fetch);

    await expect(client.rename('device', 'Phone')).resolves.toBeUndefined();
    await expect(client.revoke('device')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps stable problem codes and malformed-error fallbacks', async () => {
    const problem = createDeviceClient(
      vi.fn(
        async () => new Response(JSON.stringify({ code: 'LAST_DEVICE_REQUIRED' }), { status: 409 }),
      ) as typeof fetch,
    );
    const malformed = createDeviceClient(
      vi.fn(async () => new Response('not json', { status: 500 })) as typeof fetch,
    );

    await expect(problem.revoke('device')).rejects.toThrow('LAST_DEVICE_REQUIRED');
    await expect(malformed.revoke('device')).rejects.toThrow('AUTH_REQUEST_FAILED_500');
  });
});
