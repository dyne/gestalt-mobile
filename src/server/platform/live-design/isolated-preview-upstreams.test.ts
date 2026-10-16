/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { isolatedPreviewUpstreams } from './isolated-preview-upstreams.js';
import type { IsolatedProjectProcess, IsolatedProjectReceipt } from './isolated-project-process.js';

// Contract fixture only. Supported-host evidence separately proves real receipt/process confinement.
function fixture() {
  const resource = (role: 'helper' | 'devserver', namespace: string) => {
    const prepared = { assertCurrent: vi.fn(), open: vi.fn(() => new PassThrough()) };
    return {
      prepared,
      process: {
        verify: vi.fn(),
        prepareConnection: vi.fn(async () => prepared),
      } as unknown as IsolatedProjectProcess,
      receipt: {
        role,
        sessionId: 'owner',
        generation: 3,
        network: 'private-loopback-only',
        target: { cwd: '/app', namespaces: { net: namespace } },
      } as IsolatedProjectReceipt,
    };
  };

  return {
    instance: {
      relayId: 'owner',
      appId: 'app',
      liveId: 'live',
      generation: 3,
      previewOrigin: 'https://preview.test',
    },
    appRoot: '/app',
    helper: resource('helper', 'net:[1]'),
    devserver: resource('devserver', 'net:[2]'),
  };
}
describe('generation-bound isolated preview connections', () => {
  it('checks both owned receipts on each connection and selects only its fixed resource', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    input.instance.generation = 99;
    Object.assign(input.helper.receipt, { sessionId: 'tampered-caller' });
    (await upstreams.open('helper')).destroy();
    (await upstreams.open('app')).destroy();
    expect(input.helper.process.verify).toHaveBeenCalledTimes(1);
    expect(input.devserver.process.verify).toHaveBeenCalledTimes(1);
    expect(input.helper.process.prepareConnection).toHaveBeenCalledTimes(2);
    expect(input.devserver.process.prepareConnection).toHaveBeenCalledTimes(2);
    expect(input.helper.prepared.open).toHaveBeenCalledTimes(1);
    expect(input.devserver.prepared.open).toHaveBeenCalledTimes(1);
  });
  it.each(['session', 'generation', 'app', 'namespace', 'role', 'handle'] as const)(
    'refuses mismatched %s before any connection',
    (kind) => {
      const input = fixture();
      if (kind === 'session') Object.assign(input.helper.receipt, { sessionId: 'other-session' });
      if (kind === 'generation') Object.assign(input.devserver.receipt, { generation: 2 });
      if (kind === 'app') Object.assign(input.devserver.receipt.target, { cwd: '/other-app' });
      if (kind === 'namespace')
        Object.assign(input.devserver.receipt.target.namespaces, { net: 'net:[1]' });
      if (kind === 'role') Object.assign(input.helper.receipt, { role: 'devserver' });
      if (kind === 'handle') input.devserver.process = input.helper.process;
      expect(() => isolatedPreviewUpstreams(input)).toThrow('LIVE_PREVIEW_PROCESS_UNAVAILABLE');
      expect(input.helper.prepared.open).not.toHaveBeenCalled();
      expect(input.devserver.prepared.open).not.toHaveBeenCalled();
    },
  );
  it('refuses app traffic when helper receipt lifetime is revoked, with no TCP fallback', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    vi.mocked(input.helper.process.prepareConnection).mockImplementation(async () => {
      throw new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    });
    await expect(upstreams.open('app')).rejects.toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(input.devserver.prepared.open).not.toHaveBeenCalled();
  });
  it('waits for both independent preparations before connecting and fences revocation across the await', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(input.helper.process.prepareConnection).mockImplementation(async () => {
      await barrier;
      return input.helper.prepared;
    });
    const pending = upstreams.open('app');
    await Promise.resolve();
    expect(input.helper.process.prepareConnection).toHaveBeenCalledOnce();
    expect(input.devserver.process.prepareConnection).toHaveBeenCalledOnce();
    expect(input.helper.prepared.open).not.toHaveBeenCalled();
    expect(input.devserver.prepared.open).not.toHaveBeenCalled();
    input.helper.prepared.assertCurrent.mockImplementation(() => {
      throw new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    });
    release();
    await expect(pending).rejects.toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(input.devserver.prepared.open).not.toHaveBeenCalled();
  });
  it('cancels sibling verification when either real preparation fails', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    let signal: AbortSignal | undefined;
    vi.mocked(input.devserver.process.prepareConnection).mockImplementation(
      async (_receipt, cancellation) => {
        signal = cancellation;
        await new Promise<void>((resolve) =>
          cancellation!.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('CANCELLED');
      },
    );
    vi.mocked(input.helper.process.prepareConnection).mockRejectedValue(
      new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE'),
    );
    await expect(upstreams.open('app')).rejects.toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(signal?.aborted).toBe(true);
    expect(input.devserver.prepared.open).not.toHaveBeenCalled();
  });
});
