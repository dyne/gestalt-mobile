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
  const resource = (role: 'helper' | 'devserver', namespace: string) => ({
    process: {
      verify: vi.fn(),
      verifyForConnection: vi.fn(async () => {}),
      assertConnectionLifetime: vi.fn(),
      open: vi.fn(async () => new PassThrough()),
    } as unknown as IsolatedProjectProcess,
    receipt: {
      role,
      sessionId: 'owner',
      generation: 3,
      network: 'private-loopback-only',
      target: { cwd: '/app', namespaces: { net: namespace } },
    } as IsolatedProjectReceipt,
  });
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
    expect(input.helper.process.verifyForConnection).toHaveBeenCalledTimes(1);
    expect(input.devserver.process.verifyForConnection).toHaveBeenCalledTimes(1);
    expect(input.helper.process.open).toHaveBeenCalledTimes(1);
    expect(input.devserver.process.open).toHaveBeenCalledTimes(1);
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
      expect(input.helper.process.open).not.toHaveBeenCalled();
      expect(input.devserver.process.open).not.toHaveBeenCalled();
    },
  );
  it('refuses app traffic when helper receipt lifetime is revoked, with no TCP fallback', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    vi.mocked(input.helper.process.verifyForConnection).mockImplementation(async () => {
      throw new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    });
    await expect(upstreams.open('app')).rejects.toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(input.devserver.process.open).not.toHaveBeenCalled();
  });
  it('destroys the selected stream if the other resource is revoked during asynchronous verification', async () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(input.helper.process.verifyForConnection).mockImplementation(() => barrier);
    const selected = new PassThrough();
    vi.mocked(input.devserver.process.open).mockResolvedValue(selected);
    const pending = upstreams.open('app');
    vi.mocked(input.helper.process.assertConnectionLifetime).mockImplementation(() => {
      throw new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    });
    release();
    await expect(pending).rejects.toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(selected.destroyed).toBe(true);
  });
});
