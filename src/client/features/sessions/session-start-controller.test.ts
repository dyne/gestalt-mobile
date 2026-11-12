/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionStartController } from './session-start-controller.js';
import { createRelayClient } from './relay-client.js';
import { relayFeedback } from '../feedback/relay-messages.js';

describe('SessionStartController', () => {
  it('preserves the conflicting session identity for an explicit Open action', async () => {
    const error = Object.assign(new Error('Already running'), {
      code: 'SESSION_WORKSPACE_BUSY',
      sessionId: 'existing',
    });
    const controller = new SessionStartController(
      { start: vi.fn().mockRejectedValue(error) },
      () => 'key',
      vi.fn(),
    );
    expect(await controller.start('workspace', {})).toBeNull();
    expect(controller.state.conflict).toEqual({ workspaceId: 'workspace', sessionId: 'existing' });
  });
  it.each([
    ['CODEX_EXECUTOR_MODEL_UNAVAILABLE', 'executor model is unavailable'],
    ['CODEX_MODEL_UNAVAILABLE', 'Codex model is unavailable'],
    ['SESSION_WORKSPACE_UNAVAILABLE', 'temporary ownership could not be confirmed'],
    ['SESSION_WORKSPACE_LOCKED', 'close it to release the reservation'],
  ])('preserves %s from the API through the start controller to feedback', async (code, reason) => {
    const relay = createRelayClient(
      async () =>
        new Response(JSON.stringify({ code, detail: 'private runtime detail' }), { status: 503 }),
    );
    const feedback = vi.fn();
    const controller = new SessionStartController(
      { start: relay.startSession },
      () => 'key',
      vi.fn(),
      (error) => feedback(relayFeedback(error, 'SESSION_START_FAILED')),
    );
    expect(await controller.start('workspace', {})).toBeNull();
    expect(feedback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code, message: expect.stringContaining(reason) }),
    );
    expect(JSON.stringify(feedback.mock.calls)).not.toContain('private runtime detail');
  });

  it('does not report a late failure after disposal', async () => {
    let reject!: (reason: Error) => void;
    const onFailure = vi.fn();
    const controller = new SessionStartController(
      {
        start: () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      },
      () => 'key',
      vi.fn(),
      onFailure,
    );
    const pending = controller.start('workspace', {});
    controller.dispose();
    reject(new Error('late failure'));
    expect(await pending).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });
  it('uses one key for a request and suppresses duplicate starts', async () => {
    let resolve!: (value: { id: string; state: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ id: string; state: string }>((done) => {
          resolve = done;
        }),
    );
    const controller = new SessionStartController({ start }, () => 'start-key', vi.fn());
    const first = controller.start('workspace', {});
    const duplicate = controller.start('workspace', {});
    resolve({ id: 'session', state: 'ready' });
    expect(await first).toMatchObject({ id: 'session' });
    expect(await duplicate).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith('workspace', {}, 'start-key');
  });

  it('reuses a failed request key for a retry', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ id: 'session', state: 'ready' });
    const key = vi.fn(() => 'retry-key');
    const controller = new SessionStartController({ start }, key, vi.fn());
    await controller.start('workspace', {});
    await controller.start('workspace', {});
    expect(key).toHaveBeenCalledOnce();
    expect(start).toHaveBeenNthCalledWith(1, 'workspace', {}, 'retry-key');
    expect(start).toHaveBeenNthCalledWith(2, 'workspace', {}, 'retry-key');
  });
});
