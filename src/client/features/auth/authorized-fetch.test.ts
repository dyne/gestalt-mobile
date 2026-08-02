/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { createAuthorizedFetch } from './authorized-fetch.js';
import { createRelayClient } from '../sessions/relay-client.js';

describe('authorized fetch', () => {
  it('locks the client after AUTH_REQUIRED from an existing relay request', async () => {
    const lost = vi.fn();
    const fetcher = createAuthorizedFetch(
      lost,
      async () => new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), { status: 401 }),
    );
    await expect(createRelayClient(fetcher).listSessions()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(lost).toHaveBeenCalledOnce();
  });
});
