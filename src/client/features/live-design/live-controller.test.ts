/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { LiveController } from './live-controller.js';
import type { LiveClient, LiveRun } from './contracts.js';

const absent = () => Promise.reject(Object.assign(new Error(), { code: 'LIVE_NOT_FOUND' }));
const run = { liveId: 'live-1', generation: 1, state: 'active' };
const target = { appId: 'app', targetId: 'web' };
const fixture = () => {
  const client: LiveClient = {
    liveTargets: vi.fn(async () => ({ targets: [target] })),
    liveStatus: vi.fn(absent),
    liveStart: vi.fn(async () => run),
    liveLaunch: vi.fn(),
  };
  const publish = vi.fn();
  const notify = vi.fn();
  const controller = new LiveController(client, 'relay', publish, notify);
  return { client, controller, publish, notify };
};

describe('Live acquisition', () => {
  it('uses registered selection, suppresses concurrent Start and publishes active ownership', async () => {
    const { client, controller } = fixture();
    let complete!: (run: LiveRun) => void;
    client.liveStart = vi.fn(
      () =>
        new Promise<LiveRun>((resolve) => {
          complete = resolve;
        }),
    );
    await controller.refresh();
    const first = controller.start();
    await vi.waitFor(() => expect(client.liveStart).toHaveBeenCalledOnce());
    await controller.start();
    await controller.refresh();
    expect(controller.view.pending).toBe(true);
    expect(client.liveStart).toHaveBeenCalledWith('relay', {
      ...target,
      operationId: expect.any(String),
    });
    complete(run);
    await first;
    expect(controller.view.run).toEqual(run);
    expect(controller.view.pending).toBe(false);
  });

  it('keeps the acquisition identity after an uncertain response and reads status before retry', async () => {
    const { client, controller, notify } = fixture();
    client.liveStart = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValue(run);
    await controller.refresh();
    await controller.start();
    expect(controller.view.uncertainStart).toBe(true);
    controller.select(1);
    expect(controller.view.selection).toBe(0);
    await controller.start();
    expect(vi.mocked(client.liveStart).mock.calls[0]?.[1].operationId).toEqual(
      vi.mocked(client.liveStart).mock.calls[1]?.[1].operationId,
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(controller.view.uncertainStart).toBe(false);
  });

  it('reconciles a successful uncertain Start without acquiring again', async () => {
    const { client, controller } = fixture();
    await controller.refresh();
    client.liveStatus = vi.fn(async () => run);
    await controller.start();
    expect(client.liveStart).not.toHaveBeenCalled();
    expect(controller.view.run).toEqual(run);
  });

  it('explains missing external setup and cannot start without registered apps', async () => {
    const { client, controller } = fixture();
    client.liveTargets = vi.fn().mockRejectedValue(new Error('not configured'));
    await controller.refresh();
    expect(controller.view.guidance).toContain('Caddy');
    await controller.start();
    expect(client.liveStart).not.toHaveBeenCalled();
  });

  it('routes busy failures through notifications without displaying server details', async () => {
    const { client, controller, notify } = fixture();
    client.liveStart = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('PRIVATE'), { code: 'LIVE_APP_BUSY', status: 409 }),
      );
    await controller.refresh();
    await controller.start();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Another Live session'));
    expect(controller.view.guidance).not.toContain('PRIVATE');
  });

  it('ignores stale discovery after disposal', async () => {
    const { controller, publish } = fixture();
    const refresh = controller.refresh();
    controller.dispose();
    await refresh;
    expect(publish).not.toHaveBeenCalled();
  });

  it('starts a new generation after the server releases ownership to idle', async () => {
    const { client, controller } = fixture();
    client.liveStatus = vi.fn(async () => ({ ...run, state: 'idle' }));
    await controller.refresh();
    await controller.start();
    expect(client.liveStart).toHaveBeenCalledOnce();
  });
});
