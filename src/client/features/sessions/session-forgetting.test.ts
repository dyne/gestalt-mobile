/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionForgetOperation } from '../../../shared/contracts/session-forget.js';
import type { RelaySession } from './relay-client.js';
import { SessionForgetting, type SessionForgetState } from './session-forgetting.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const owner: RelaySession = {
  id: 'owner',
  state: 'released',
  workspacePath: '/workspace',
  threadId: 'history',
};
const operation = (
  phase: SessionForgetOperation['phase'],
  updatedAt = '2026-11-04T10:00:00.000Z',
): SessionForgetOperation => ({
  operationId: 'forget-1',
  sessionId: owner.id,
  phase,
  updatedAt,
  ...(phase === 'failed' ? { failureCode: 'SESSION_CLEANUP_FAILED' as const } : {}),
});
function fixture() {
  let states: ReadonlyMap<string, SessionForgetState> = new Map();
  const request = deferred<void>();
  const relay = {
    forgetSession: vi.fn(() => request.promise),
    getSession: vi.fn(async (): Promise<RelaySession> => owner),
  };
  const onComplete = vi.fn();
  const onError = vi.fn();
  const workflow = new SessionForgetting({
    relay,
    publish: (next) => {
      states = next;
    },
    onComplete,
    onError,
  });
  return {
    workflow,
    relay,
    request,
    onComplete,
    onError,
    get states() {
      return states;
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('owner-specific forgetting', () => {
  it('is immediately busy, joins duplicate clicks and leaves another owner available through delayed stop and deletion', async () => {
    const f = fixture();
    const task = f.workflow.forget(owner);
    expect(f.states.get(owner.id)?.phase).toBe('requesting');
    expect(f.workflow.forget(owner)).toBe(task);
    expect(f.relay.forgetSession).toHaveBeenCalledTimes(1);
    expect(f.workflow.isBusy('another-owner')).toBe(false);
    f.relay.getSession.mockResolvedValue({ ...owner, forgetOperation: operation('stopping') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.states.get(owner.id)?.phase).toBe('stopping');
    f.relay.getSession.mockResolvedValue({
      ...owner,
      forgetOperation: operation('cleaning', '2026-11-04T10:00:01.000Z'),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.states.get(owner.id)?.phase).toBe('cleaning');
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(f.workflow.reconcile([])).toEqual([owner]);
    f.request.resolve();
    await task;
    expect(f.onComplete).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.states.size).toBe(0);
    f.workflow.dispose();
  });

  it('restores failed controls, reports one failure, and permits a successful retry', async () => {
    const f = fixture();
    f.relay.getSession.mockResolvedValue({ ...owner, forgetOperation: operation('failed') });
    const task = f.workflow.forget(owner);
    f.request.reject(new Error('SESSION_FORGET_FAILED'));
    await task;
    expect(f.states.get(owner.id)?.phase).toBe('failed');
    expect(f.workflow.isBusy(owner.id)).toBe(false);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.workflow.observe(owner.id, operation('failed'));
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.relay.forgetSession.mockResolvedValueOnce();
    await f.workflow.forget(owner);
    expect(f.relay.forgetSession).toHaveBeenCalledTimes(2);
    expect(f.onComplete).toHaveBeenCalledTimes(1);
    f.workflow.dispose();
  });

  it('recovers a busy operation on reload and confirms completion through an authoritative missing-owner response', async () => {
    const f = fixture();
    f.workflow.reconcile([{ ...owner, forgetOperation: operation('cleaning') }]);
    expect(f.workflow.isBusy(owner.id)).toBe(true);
    f.relay.getSession.mockRejectedValueOnce(
      Object.assign(new Error('SESSION_NOT_FOUND'), { status: 404 }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.onComplete).toHaveBeenCalledTimes(1);
    expect(f.relay.forgetSession).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('recovers a failed operation on reload without retrying it automatically', () => {
    const f = fixture();
    f.workflow.reconcile([{ ...owner, forgetOperation: operation('failed') }]);
    expect(f.states.get(owner.id)?.phase).toBe('failed');
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.relay.forgetSession).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('keeps a lost request busy while the backend is still cleaning', async () => {
    const f = fixture();
    f.relay.getSession.mockResolvedValue({ ...owner, forgetOperation: operation('cleaning') });
    const task = f.workflow.forget(owner);
    f.request.reject(new Error('connection closed'));
    await task;
    expect(f.workflow.isBusy(owner.id)).toBe(true);
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('preserves the frame through disconnected polling then recovers a durable failed state', async () => {
    const f = fixture();
    f.workflow.reconcile([{ ...owner, forgetOperation: operation('stopping') }]);
    f.relay.getSession.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.workflow.isBusy(owner.id)).toBe(true);
    expect(f.onComplete).not.toHaveBeenCalled();
    f.relay.getSession.mockResolvedValue({
      ...owner,
      forgetOperation: operation('failed', '2026-11-04T10:00:02.000Z'),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.workflow.isBusy(owner.id)).toBe(false);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.workflow.dispose();
  });

  it('does not infer completion from an empty roster while a request is pending', () => {
    const f = fixture();
    void f.workflow.forget(owner);
    expect(f.workflow.reconcile([])).toEqual([owner]);
    expect(f.onComplete).not.toHaveBeenCalled();
    f.workflow.dispose();
    f.request.resolve();
  });

  it('ignores another owner, malformed events and an older operation phase', () => {
    const f = fixture();
    f.workflow.reconcile([owner]);
    f.workflow.observe(owner.id, { ...operation('completed'), sessionId: 'someone-else' });
    f.workflow.observe(owner.id, { phase: 'completed' });
    f.workflow.observe(owner.id, operation('cleaning', '2026-11-04T10:00:02.000Z'));
    f.workflow.observe(owner.id, operation('stopping'));
    expect(f.states.get(owner.id)?.phase).toBe('cleaning');
    expect(f.onComplete).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('does not resurrect a completed owner from a late list or event', async () => {
    const f = fixture();
    const task = f.workflow.forget(owner);
    f.workflow.observe(owner.id, operation('completed'));
    f.request.resolve();
    await task;
    expect(f.workflow.reconcile([owner])).toEqual([]);
    f.workflow.observe(owner.id, operation('stopping'));
    expect(f.states.size).toBe(0);
    expect(f.onComplete).toHaveBeenCalledTimes(1);
    f.workflow.dispose();
  });

  it('unlocks a rejected request only after confirming that no backend operation began', async () => {
    const f = fixture();
    const task = f.workflow.forget(owner);
    f.request.reject(new Error('unavailable'));
    await task;
    expect(f.states.get(owner.id)?.phase).toBe('failed');
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.onComplete).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('keeps unknown transport outcomes busy until a subsequent authoritative read', async () => {
    const f = fixture();
    f.relay.getSession.mockRejectedValueOnce(new Error('offline'));
    const task = f.workflow.forget(owner);
    f.request.reject(new Error('offline'));
    await task;
    expect(f.workflow.isBusy(owner.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.workflow.isBusy(owner.id)).toBe(false);
    expect(f.states.get(owner.id)?.phase).toBe('failed');
    expect(f.onComplete).not.toHaveBeenCalled();
    f.workflow.dispose();
  });

  it('disposes polling and ignores a late response after unmount', async () => {
    const f = fixture();
    const task = f.workflow.forget(owner);
    f.workflow.dispose();
    f.request.resolve();
    await task;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.relay.getSession).not.toHaveBeenCalled();
    expect(f.onComplete).not.toHaveBeenCalled();
  });
});
