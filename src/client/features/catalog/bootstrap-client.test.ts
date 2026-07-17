/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { loadBootstrap } from './bootstrap-client.js';
describe('loadBootstrap', () => {
  it('returns the API payload', async () => {
    await expect(
      loadBootstrap(async () => new Response('{"ok":true}', { status: 200 }) as Response),
    ).resolves.toEqual({ ok: true });
  });
});
