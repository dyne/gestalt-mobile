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
      open: vi.fn(() => new PassThrough()),
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
  it('checks both owned receipts on each connection and selects only its fixed resource', () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    input.instance.generation = 99;
    Object.assign(input.helper.receipt, { sessionId: 'tampered-caller' });
    upstreams.open('helper').destroy();
    upstreams.open('app').destroy();
    expect(input.helper.process.verify).toHaveBeenCalledTimes(3);
    expect(input.devserver.process.verify).toHaveBeenCalledTimes(3);
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
  it('refuses app traffic when helper receipt lifetime is revoked, with no TCP fallback', () => {
    const input = fixture();
    const upstreams = isolatedPreviewUpstreams(input);
    vi.mocked(input.helper.process.verify).mockImplementation(() => {
      throw new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    });
    expect(() => upstreams.open('app')).toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(input.devserver.process.open).not.toHaveBeenCalled();
  });
});
