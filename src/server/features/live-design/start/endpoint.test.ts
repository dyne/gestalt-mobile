/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, expect, it, vi } from 'vitest';
import { previewAuthFixture, mobileOrigin } from '../preview-auth.fixture.js';
import type { LiveRun } from '../application/ownership.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('authenticates Start and admits only opaque registered selections, never a supplied launch', async () => {
  // HTTP contract fixture, not runtime/admission evidence.
  const start = vi.fn(
    async () =>
      ({
        state: 'active',
        liveId: 'live',
        generation: 1,
        previewOrigin: 'https://preview.test',
      }) as LiveRun,
  );
  const f = await previewAuthFixture(cleanup, 5000, {
    targetsForRelay: () => [{ appId: 'app', targetId: 'target' }],
    start,
  });
  const url = '/api/sessions/relay/live/start',
    payload = { appId: 'app', targetId: 'target', operationId: 'operation' };
  const headers = { origin: mobileOrigin, cookie: f.cookieHeader };
  expect(
    (await f.mobile.inject({ method: 'POST', url, payload, headers: { origin: mobileOrigin } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await f.mobile.inject({
        method: 'POST',
        url,
        payload,
        headers: { ...headers, origin: 'https://project.test' },
      })
    ).statusCode,
  ).toBe(403);
  for (const extra of [
    { command: 'unsafe' },
    { pid: 1 },
    { url: 'http://127.0.0.1' },
    { receipt: {} },
    { globallyExclusive: false },
  ])
    expect(
      (await f.mobile.inject({ method: 'POST', url, payload: { ...payload, ...extra }, headers }))
        .statusCode,
    ).toBe(400);
  expect(start).not.toHaveBeenCalled();
  const response = await f.mobile.inject({ method: 'POST', url, payload, headers });
  expect(response.statusCode).toBe(200);
  expect(start).toHaveBeenCalledWith({
    relayId: 'relay',
    ...payload,
    deviceId: f.device.id,
    authSessionHash: f.deps.secrets.hash(f.session),
  });
  expect(response.json()).toEqual({
    state: 'active',
    liveId: 'live',
    generation: 1,
    previewOrigin: 'https://preview.test',
  });
});
it('never relays native errors, configuration, private paths or provider details', async () => {
  const f = await previewAuthFixture(cleanup, 5000, {
    targetsForRelay: () => [],
    start: async () => {
      throw new Error('private provider/configuration response');
    },
  });
  const response = await f.mobile.inject({
    method: 'POST',
    url: '/api/sessions/relay/live/start',
    payload: { appId: 'app', targetId: 'target', operationId: 'operation' },
    headers: { origin: mobileOrigin, cookie: f.cookieHeader },
  });
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain('private provider');
  expect(response.json().code).toBe('LIVE_START_FAILED');
});
