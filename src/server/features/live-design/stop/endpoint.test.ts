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
it.each(['stop', 'resume'] as const)(
  'authenticates %s and rejects unscoped runtime/configuration input',
  async (action) => {
    const execute = vi.fn(
      async () =>
        ({
          liveId: 'live',
          generation: 2,
          state: 'idle',
          previewOrigin: 'https://preview.test',
        }) as LiveRun,
    );
    const f = await previewAuthFixture(cleanup, 5000, {
      targetsForRelay: () => [],
      start: vi.fn(),
      [action]: execute,
    });
    const url = `/api/sessions/relay/live/${action}`,
      payload = { liveId: 'live', generation: 1 };
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
      { pid: 1 },
      { command: 'unsafe' },
      { permissions: 'broader' },
      { authSessionHash: 'other' },
      { captureId: 'invented' },
    ])
      expect(
        (await f.mobile.inject({ method: 'POST', url, payload: { ...payload, ...extra }, headers }))
          .statusCode,
      ).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect((await f.mobile.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith({
      relayId: 'relay',
      ...payload,
      authSessionHash: f.deps.secrets.hash(f.session),
      deviceId: f.device.id,
    });
    execute.mockRejectedValueOnce(new Error('LIVE_GENERATION_STALE'));
    expect((await f.mobile.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(409);
    execute.mockRejectedValueOnce(new Error('private account/configuration'));
    const failed = await f.mobile.inject({ method: 'POST', url, payload, headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private account');
  },
);

it('publishes the actual recovery generation only to its owning authenticated Mobile session', async () => {
  const f = await previewAuthFixture(cleanup);
  f.deps.owners.read = () => ({
    ...f.audience(),
    active: false,
    state: 'recoveryRequired',
    generation: 2,
  });
  const status = await f.mobile.inject({
    url: '/api/sessions/relay/live',
    headers: { cookie: f.cookieHeader },
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual({
    liveId: 'live',
    generation: 2,
    state: 'recoveryRequired',
    leases: [],
  });
  expect(
    (
      await f.launch({
        liveId: 'live',
        generation: 2,
        codeChallenge: 'a'.repeat(43),
        codeChallengeMethod: 'S256',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await f.mobile.inject({
        url: '/api/sessions/relay/live',
        headers: { cookie: `gestalt_mobile_session=${f.otherSession}` },
      })
    ).statusCode,
  ).toBe(404);
});
