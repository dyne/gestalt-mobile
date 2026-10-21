/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPreview } from './open-preview.js';
import type { LiveClient } from './contracts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('private preview opening', () => {
  it('binds proof to the exact popup, origin and grant, then erases its listener', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const peer = { location: { replace: vi.fn() }, postMessage: vi.fn(), close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(peer as unknown as Window);
    const client = {
      liveLaunch: vi.fn(async () => ({
        grantId: 'grant-1',
        grant: 'a'.repeat(43),
        previewOrigin: 'https://preview.example.test',
      })),
    } as unknown as LiveClient;
    const failed = vi.fn();
    const attempt = openPreview(client, 'relay', { liveId: 'live', generation: 1 }, failed);
    await vi.waitFor(() => expect(peer.location.replace).toHaveBeenCalledOnce());
    const message = (
      origin: string,
      source: Window,
      type = 'gestalt-live-proof',
      grantId = 'grant-1',
    ) =>
      window.dispatchEvent(
        new MessageEvent('message', { origin, source, data: { type, grantId } }),
      );
    message('https://evil.example.test', peer as unknown as Window);
    message('https://preview.example.test', window);
    message(
      'https://preview.example.test',
      peer as unknown as Window,
      'gestalt-live-proof',
      'wrong',
    );
    expect(peer.postMessage).not.toHaveBeenCalled();
    message('https://preview.example.test', peer as unknown as Window);
    expect(peer.postMessage).toHaveBeenCalledWith(
      {
        type: 'gestalt-live-proof',
        grantId: 'grant-1',
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
      'https://preview.example.test',
    );
    message('https://preview.example.test', peer as unknown as Window, 'gestalt-live-exchanged');
    peer.postMessage.mockClear();
    message('https://preview.example.test', peer as unknown as Window);
    expect(peer.postMessage).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    attempt.dispose();
  });

  it('does not mint a grant when the popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const client = { liveLaunch: vi.fn() } as unknown as LiveClient;
    expect(openPreview(client, 'relay', { liveId: 'live', generation: 1 }, vi.fn()).opened).toBe(
      false,
    );
    expect(client.liveLaunch).not.toHaveBeenCalled();
  });

  it('does not navigate a pending popup after the owning component is disposed', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const peer = { location: { replace: vi.fn() }, postMessage: vi.fn(), close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(peer as unknown as Window);
    let resolve!: (value: unknown) => void;
    const client = {
      liveLaunch: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    } as unknown as LiveClient;
    const attempt = openPreview(client, 'relay', { liveId: 'live', generation: 1 }, vi.fn());
    await vi.waitFor(() => expect(client.liveLaunch).toHaveBeenCalledOnce());
    attempt.dispose();
    resolve({
      grantId: 'grant-1',
      grant: 'a'.repeat(43),
      previewOrigin: 'https://preview.example.test',
    });
    await Promise.resolve();
    expect(peer.location.replace).not.toHaveBeenCalled();
  });
});
