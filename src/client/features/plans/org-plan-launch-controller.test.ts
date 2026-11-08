/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { OrgPlanLaunchController } from './org-plan-launch-controller.js';
import { createRelayClient } from '../sessions/relay-client.js';
import type { OrgPlanLaunchResult } from '../../../shared/contracts/org-plan-execution.js';

const intent = {
  reference: { kind: 'retained-session' as const, sessionId: 'source' },
  expectedRevision: 'seen',
  skillProfile: 'supervisor',
};
const result: OrgPlanLaunchResult = {
  kind: 'started',
  launchId: 'stable',
  session: { id: 'ordinary', state: 'turnActive' },
  bootstrap: { kind: 'accepted', requestId: 'bootstrap', turnId: 'turn' },
};

it('supports two independent trigger adapters with shared in-flight and retry identity through the typed transport', async () => {
  let release!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(new Response(JSON.stringify(result)));
  const controller = new OrgPlanLaunchController(
    createRelayClient(fetcher),
    () => 'stable',
    vi.fn(),
  );
  const catalogTrigger = () => controller.submit(intent);
  const retainedPlanTrigger = () =>
    controller.submit({ ...intent, reference: { ...intent.reference } });
  expect(await catalogTrigger()).toBeNull();
  expect(controller.state.error).toBe('Response lost');
  const pending = retainedPlanTrigger();
  try {
    expect(controller.state.submitting).toBe(true);
    expect(await catalogTrigger()).toBeNull();
    release(new Response(JSON.stringify(result)));
    expect(await pending).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe('/api/plans/execute');
      expect(JSON.parse(options.body)).toEqual({ ...intent, launchId: 'stable' });
    }
  } finally {
    release(new Response(JSON.stringify(result)));
    await pending;
  }
});

it('keeps partial receipt retry identity and gives changed confirmation inputs a fresh identity', async () => {
  const partial: OrgPlanLaunchResult = {
    kind: 'partial',
    launchId: 'one',
    session: result.session,
    bootstrap: { kind: 'pending' },
    stage: 'bootstrap',
    reason: 'Retry.',
  };
  const startOrgPlanSupervision = vi.fn().mockResolvedValue(partial);
  const key = vi.fn().mockReturnValueOnce('one').mockReturnValueOnce('two');
  const controller = new OrgPlanLaunchController({ startOrgPlanSupervision }, key, vi.fn());
  expect(await controller.submit(intent)).toEqual(partial);
  await controller.submit(intent);
  await controller.submit({ ...intent, skillProfile: '' });
  expect(startOrgPlanSupervision.mock.calls.map(([request]) => request.launchId)).toEqual([
    'one',
    'one',
    'two',
  ]);
});

it.each([
  { kind: 'blocked', code: 'CONTEXT_CHANGED', reason: 'Refresh and confirm.' },
  {
    kind: 'blocked',
    code: 'ACTIVE_SUPERVISION',
    reason: 'Open the owner.',
    existingSessionId: 'existing-owner',
  },
  { kind: 'rejected', code: 'LAUNCH_CONFLICT', reason: 'Intent changed.' },
])('preserves the typed HTTP 409 $code receipt through the controller', async (receipt) => {
  const controller = new OrgPlanLaunchController(
    createRelayClient(async () => new Response(JSON.stringify(receipt), { status: 409 })),
    () => 'stable',
    vi.fn(),
  );
  expect(await controller.submit(intent)).toEqual(receipt);
  expect(controller.state).toEqual({ submitting: false, error: null });
});

it('preserves the intentional typed invalid-request HTTP 400 receipt', async () => {
  const receipt = {
    kind: 'rejected',
    code: 'INVALID_LAUNCH_REQUEST',
    reason: 'Confirm a valid plan.',
  };
  const controller = new OrgPlanLaunchController(
    createRelayClient(async () => new Response(JSON.stringify(receipt), { status: 400 })),
    () => 'stable',
    vi.fn(),
  );
  expect(await controller.submit(intent)).toEqual(receipt);
});

it.each([
  [409, '{broken-json'],
  [
    409,
    JSON.stringify({
      kind: 'blocked',
      code: 'ACTIVE_SUPERVISION',
      existingSessionId: 42,
      reason: 'Invalid identity.',
    }),
  ],
  [400, JSON.stringify({ code: 'INVALID_LAUNCH_REQUEST' })],
  [401, JSON.stringify({ kind: 'blocked', code: 'ACTIVE_SUPERVISION', reason: 'Not authorized.' })],
  [403, JSON.stringify({ code: 'FORBIDDEN' })],
])('keeps malformed or unauthorized HTTP %i responses as errors', async (status, body) => {
  const controller = new OrgPlanLaunchController(
    createRelayClient(async () => new Response(body, { status })),
    () => 'stable',
    vi.fn(),
  );
  expect(await controller.submit(intent)).toBeNull();
  expect(controller.state.error).toBe(`Relay request failed (${status}).`);
});

it('suppresses results and state publication after disposal without claiming server cancellation', async () => {
  let release!: (result: OrgPlanLaunchResult) => void;
  const startOrgPlanSupervision = vi.fn(
    () =>
      new Promise<OrgPlanLaunchResult>((resolve) => {
        release = resolve;
      }),
  );
  const onChange = vi.fn();
  const controller = new OrgPlanLaunchController(
    { startOrgPlanSupervision },
    () => 'stable',
    onChange,
  );
  const pending = controller.submit(intent);
  try {
    controller.dispose();
    release(result);
    expect(await pending).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await controller.submit(intent)).toBeNull();
    expect(startOrgPlanSupervision).toHaveBeenCalledTimes(1);
  } finally {
    release(result);
    await pending;
  }
});
